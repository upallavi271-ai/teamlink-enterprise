// ---------------------------------------------------------------------------
// OFFER LETTER TEMPLATES and SALARY BREAKUP (founder ATS audit 2026-11-18, items 252 / 253).
//
//   Templates   An Admin keeps several: name, body with {{placeholders}}, and the client or industry it is for. An offer picks one: the one
//               chosen on that offer, else the template of the client, else the template of the client's industry, else the one marked
//               default, else the single template that was there before (AppSetting "offer-letter-template") - so nothing changes until an Admin adds one.
//   Breakup     Basic, HRA, special allowance, PF, gratuity, bonus. Worked out from the CTC by a default percent split the Admin can change
//               (AppSetting "offer.breakupSplit"; special allowance is the balance, so the parts ALWAYS add up to the CTC). The recruiter can edit the
//               amounts on one offer; the total must equal the CTC. A saved breakup is printed in the letter ({{breakup}}, else after the "Annual CTC" line).
// Raw tables, created on first use (no migration).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        'CREATE TABLE IF NOT EXISTS "OfferTemplate" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "body" TEXT NOT NULL, "clientId" TEXT, "industry" TEXT, "isDefault" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "OfferBreakup" ("applicationId" TEXT PRIMARY KEY, "ctc" REAL, "components" TEXT, "templateId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const txt = (v, n = 200) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
const r0 = (n) => Math.round(Number(n) || 0);
const inr = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const TOKENS = ['name', 'job', 'company', 'ctc', 'joiningDate', 'location', 'notes', 'offerDate', 'replyBy', 'sender', 'breakup'];

// ------------------------------------------------------------------ templates
const shape = (r) => ({ id: r.id, name: r.name, body: r.body, clientId: r.clientId || null, industry: r.industry || null, isDefault: Number(r.isDefault) === 1, active: Number(r.active) === 1, byName: r.byName, at: r.at });
async function list({ all = true } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "OfferTemplate" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "name"`);
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: rows.map((r) => r.clientId).filter(Boolean) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ ...shape(r), clientName: r.clientId ? clients.get(r.clientId) || null : null }));
}
async function get(id) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "OfferTemplate" WHERE "id" = ?', String(id));
  return r ? shape(r) : null;
}
// -> { value } | { error }
async function clean(b) {
  const name = txt(b.name, 100);
  const body = String(b.body || '').trim();
  if (!name) return { error: 'Give the template a name.' };
  if (body.length < 20) return { error: 'The letter is too short - write at least a couple of lines.' };
  if (body.length > 8000) return { error: 'The letter is too long (8,000 characters at most).' };
  const unknown = [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].filter((k) => !TOKENS.includes(k));
  if (unknown.length) return { error: `Unknown placeholder: ${unknown.map((k) => `{{${k}}}`).join(', ')}. Use: ${TOKENS.map((k) => `{{${k}}}`).join(', ')}.` };
  let clientId = txt(b.clientId, 60);
  if (clientId && !(await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } }))) return { error: 'That client was not found.' };
  const industry = txt(b.industry, 80);
  if (clientId && industry) return { error: 'Choose a client OR an industry, not both.' };
  if (!clientId) clientId = null;
  return { value: { name, body, clientId, industry, isDefault: !!b.isDefault, active: b.active !== false } };
}
async function save(id, v, byName) {
  await ensure();
  const tid = id || `ot_${crypto.randomUUID().slice(0, 12)}`;
  if (v.isDefault) await prisma.$executeRawUnsafe('UPDATE "OfferTemplate" SET "isDefault" = 0 WHERE "id" <> ?', tid);
  await prisma.$executeRawUnsafe('INSERT INTO "OfferTemplate" ("id","name","body","clientId","industry","isDefault","active","byName","at") VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET "name"=excluded."name","body"=excluded."body","clientId"=excluded."clientId","industry"=excluded."industry","isDefault"=excluded."isDefault","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"',
    tid, v.name, v.body, v.clientId, v.industry, v.isDefault ? 1 : 0, v.active ? 1 : 0, byName || null, new Date().toISOString());
  return get(tid);
}
async function remove(id) { await ensure(); await prisma.$executeRawUnsafe('DELETE FROM "OfferTemplate" WHERE "id" = ?', String(id)); }

// The template an offer uses. app needs { id, requirement: { clientId, internal, client: { industry } } }. fallbackText = the single old template's text.
async function pick(app, fallbackText) {
  await ensure();
  const [bk] = await prisma.$queryRawUnsafe('SELECT "templateId" FROM "OfferBreakup" WHERE "applicationId" = ?', app.id);
  const all = (await list({ all: false }));
  const r = app.requirement || {};
  const industry = String((r.client && r.client.industry) || '').trim().toLowerCase();
  let hit = null; let why = null;
  if (bk && bk.templateId) { hit = all.find((t) => t.id === bk.templateId); if (hit) why = 'chosen on this offer'; }
  if (!hit && r.clientId) { hit = all.find((t) => t.clientId === r.clientId); if (hit) why = `for the client`; }
  if (!hit && industry) { hit = all.find((t) => t.industry && t.industry.toLowerCase() === industry); if (hit) why = `for the ${hit.industry} industry`; }
  if (!hit) { hit = all.find((t) => t.isDefault); if (hit) why = 'the default template'; }
  if (hit) return { text: hit.body, templateId: hit.id, templateName: hit.name, why };
  return { text: fallbackText, templateId: null, templateName: 'Standard letter', why: 'the standard letter' };
}
async function chooseForOffer(applicationId, templateId, byName) {
  await ensure();
  if (templateId && !(await get(templateId))) return { error: 'That template does not exist.' };
  await prisma.$executeRawUnsafe('INSERT INTO "OfferBreakup" ("applicationId","templateId","byName","at") VALUES (?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "templateId"=excluded."templateId","byName"=excluded."byName","at"=excluded."at"',
    applicationId, templateId || null, byName || null, new Date().toISOString());
  return { ok: true };
}

// ------------------------------------------------------------------ breakup
const PARTS = [
  { key: 'basic', label: 'Basic' }, { key: 'hra', label: 'HRA' }, { key: 'specialAllowance', label: 'Special allowance' },
  { key: 'pf', label: 'PF (employer)' }, { key: 'gratuity', label: 'Gratuity' }, { key: 'bonus', label: 'Bonus' },
];
const DEFAULT_SPLIT = { basic: 40, hra: 20, pf: 4.8, gratuity: 1.9, bonus: 8.33 }; // percent of annual CTC; special allowance is the balance (about 25%)
const SPLIT_KEY = 'offer.breakupSplit';
async function splitSetting() {
  const row = await prisma.appSetting.findUnique({ where: { key: SPLIT_KEY } }).catch(() => null);
  try { const v = row ? JSON.parse(row.value) : null; if (v && v.split) return { split: { ...DEFAULT_SPLIT, ...v.split }, custom: true, updatedByName: row.updatedByName }; } catch { /* default */ }
  return { split: { ...DEFAULT_SPLIT }, custom: false };
}
// body.split: { basic, hra, pf, gratuity, bonus } percents. Special allowance = 100 - these, must stay >= 0.
async function saveSplit(body, user) {
  const split = {};
  for (const k of Object.keys(DEFAULT_SPLIT)) {
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `${PARTS.find((p) => p.key === k).label} must be a percent from 0 to 100.` };
    split[k] = Math.round(n * 100) / 100;
  }
  const sum = Object.values(split).reduce((a, b) => a + b, 0);
  if (sum > 100) return { error: `The parts add up to ${Math.round(sum * 100) / 100}%, more than 100%. Special allowance is the balance and cannot be below zero.` };
  const before = await splitSetting();
  const value = JSON.stringify({ split });
  await prisma.appSetting.upsert({ where: { key: SPLIT_KEY }, create: { key: SPLIT_KEY, value, updatedById: user.id, updatedByName: user.name }, update: { value, updatedById: user.id, updatedByName: user.name } });
  return { before: before.split, split };
}
// Parts from a CTC: each % of CTC to the rupee; special allowance = the balance, so the total is exactly the CTC.
function compute(ctc, split) {
  const c = r0(ctc);
  const s = { ...DEFAULT_SPLIT, ...(split || {}) };
  const out = {};
  let used = 0;
  Object.keys(DEFAULT_SPLIT).forEach((k) => { out[k] = r0((c * Number(s[k])) / 100); used += out[k]; });
  out.specialAllowance = c - used;
  if (out.specialAllowance < 0) { out.basic += out.specialAllowance; out.specialAllowance = 0; }
  return out;
}
function totalOf(c) { return PARTS.reduce((a, p) => a + r0(c && c[p.key]), 0); }
// A person's edit: every part a non-negative number, total = CTC (within a rupee). -> { value } | { error }
function checkComponents(comp, ctc) {
  const out = {};
  for (const p of PARTS) {
    const n = Number(comp && comp[p.key] !== undefined && comp[p.key] !== '' ? comp[p.key] : 0);
    if (!Number.isFinite(n) || n < 0) return { error: `${p.label} must be a number, zero or more.` };
    out[p.key] = r0(n);
  }
  const total = totalOf(out);
  if (Math.abs(total - r0(ctc)) > 1) return { error: `The parts add up to ${inr(total)} but the CTC is ${inr(ctc)}. They must be equal (${total > r0(ctc) ? 'reduce' : 'add'} ${inr(Math.abs(total - r0(ctc)))}).` };
  return { value: out };
}
async function getBreakup(app) {
  await ensure();
  const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "OfferBreakup" WHERE "applicationId" = ?', app.id);
  const { split } = await splitSetting();
  const ctc = Number(app.offeredCtc) || 0;
  let saved = null;
  if (row && row.components) { try { saved = JSON.parse(row.components); } catch { saved = null; } }
  return {
    ctc, saved: !!saved, components: saved || (ctc > 0 ? compute(ctc, split) : null), ctcAtSave: row && row.ctc != null ? Number(row.ctc) : null,
    stale: !!(saved && row && row.ctc != null && Math.abs(Number(row.ctc) - ctc) > 1), parts: PARTS, split, byName: row && row.byName, at: row && row.at,
  };
}
async function saveBreakup(app, comp, byName) {
  await ensure();
  const ctc = Number(app.offeredCtc) || 0;
  if (!(ctc > 0)) return { error: 'Set the offered CTC first.' };
  const chk = checkComponents(comp, ctc);
  if (chk.error) return chk;
  await prisma.$executeRawUnsafe('INSERT INTO "OfferBreakup" ("applicationId","ctc","components","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "ctc"=excluded."ctc","components"=excluded."components","byName"=excluded."byName","at"=excluded."at"',
    app.id, ctc, JSON.stringify(chk.value), byName || null, new Date().toISOString());
  return { ok: true, components: chk.value };
}
async function clearBreakup(applicationId) {
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "OfferBreakup" SET "components" = NULL, "ctc" = NULL WHERE "applicationId" = ?', applicationId);
}
// The printed block for the letter ('' when nothing was saved, or the CTC has since changed and the saved parts no longer add up).
async function breakupText(app) {
  const b = await getBreakup(app);
  if (!b.saved || b.stale || !b.components) return '';
  const lines = PARTS.map((p) => `  ${p.label}: ${inr(b.components[p.key])} per year`);
  return ['Salary breakup (per year):', ...lines, `  Total (CTC): ${inr(totalOf(b.components))} per year`].join('\n');
}
// A letter whose template has no {{breakup}} gets the block after its "Annual CTC" line (else at the end).
function injectBreakup(text, block, templateText) {
  if (!block || /\{\{breakup\}\}/.test(String(templateText || ''))) return text;
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => /^\s*annual ctc/i.test(l));
  if (at >= 0) { lines.splice(at + 1, 0, '', block); return lines.join('\n'); }
  return `${text}\n\n${block}`;
}

module.exports = {
  ensure, list, get, clean, save, remove, pick, chooseForOffer, PARTS, DEFAULT_SPLIT, TOKENS, splitSetting, saveSplit, compute, totalOf, checkComponents,
  getBreakup, saveBreakup, clearBreakup, breakupText, injectBreakup,
};
