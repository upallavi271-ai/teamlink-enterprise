// ---------------------------------------------------------------------------
// ATS FLOW SETTINGS (founder ATS audit, 2026-11-17 — Mandatory): admin-named stages, custom sub-statuses, the checklist
// before a profile goes to the client, and the fee type of a client's agreement (% of CTC, fixed per joining, or slabs).
//
//   Stage names     The stage CODES (utils/atsVocab.js STAGE_CODES) stay fixed: permissions (STAGE_OWNERS), the chain, reports and
//                   workers all key on them, so an Admin can never delete or reorder one. An Admin RENAMES the label only. The
//                   rename is written into atsVocab's STAGE_LABELS object in place, so every server path that names a stage
//                   (stageLabel / stageLabelFor / STAGE_LABELS[...]) says the new word; the web app reads the same list from
//                   GET /api/ats/stage-labels. Table "AtsStageLabel". Reset = the table emptied, the built-in words back.
//   Sub-statuses    Under a core stage, an ordered list (e.g. Interview booked: 2nd round, Technical round, HR round). The person
//                   who owns that stage (the one who may move a candidate into it, permissions.canMoveToStage) sets one on an
//                   application; it shows as a chip next to the stage, can be filtered on, and is written to the timeline.
//                   It never changes who may move the stage. A sub-status belongs to the stage it was set at: once the
//                   application moves on, it no longer shows. Tables "AtsSubStatus", "AppSubStatus", "AppSubStatusLog".
//   Share checklist Moving a profile into "Sent to client" for the first time needs every item ticked (resume, CTC, notice
//                   period, consent, contact verified, and the industry template's required "Interview" items). Facts the app
//                   can check itself (a resume on file, both salaries, a notice period) must also be on file. An Admin
//                   switches items off. Setting row AppSetting "ats.shareChecklist".
//   Fee type        PERCENT_CTC (as before), FIXED / PER_CANDIDATE (Rs. per joining, client.feeAmount) or SLAB (CTC bands -> %,
//                   table "ClientFeeSlab"). The joining invoice (utils/joining.js) takes its fee from here. Invoices already
//                   raised are never touched.
// Raw tables, created on first use (no migration) — the utils/recycleBin.js pattern. Every change is audited by the routes.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const V = require('./atsVocab');

const DEFAULT_LABELS = Object.freeze({ ...V.STAGE_LABELS });

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        'CREATE TABLE IF NOT EXISTS "AtsStageLabel" ("code" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "AtsSubStatus" ("id" TEXT PRIMARY KEY, "stage" TEXT NOT NULL, "label" TEXT NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "AtsSubStatus_stage" ON "AtsSubStatus" ("stage")',
        'CREATE TABLE IF NOT EXISTS "AppSubStatus" ("applicationId" TEXT PRIMARY KEY, "subStatusId" TEXT NOT NULL, "stage" TEXT NOT NULL, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "AppSubStatus_sub" ON "AppSubStatus" ("subStatusId")',
        'CREATE TABLE IF NOT EXISTS "AppSubStatusLog" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "applicationId" TEXT NOT NULL, "stage" TEXT NOT NULL, "fromLabel" TEXT, "toLabel" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "AppSubStatusLog_app" ON "AppSubStatusLog" ("applicationId")',
        'CREATE TABLE IF NOT EXISTS "ClientFeeSlab" ("clientId" TEXT PRIMARY KEY, "slabs" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const txt = (v, n = 200) => { const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' '); return s ? s.slice(0, n) : null; };
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- stage names
// Rebuilds atsVocab.STAGE_LABELS in place: the built-in words, then the Admin's renames on top.
let loadedAt = 0;
async function refreshLabels() {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "code","label" FROM "AtsStageLabel"');
  Object.keys(DEFAULT_LABELS).forEach((k) => { V.STAGE_LABELS[k] = DEFAULT_LABELS[k]; });
  rows.forEach((r) => { if (DEFAULT_LABELS[r.code] && r.label) V.STAGE_LABELS[r.code] = r.label; });
  loadedAt = Date.now();
  return { ...V.STAGE_LABELS };
}
// Another server process may have saved a rename: the list is re-read at most once every 30 seconds.
async function labelsFresh() {
  if (Date.now() - loadedAt > 30000) await refreshLabels().catch(() => null);
  return { ...V.STAGE_LABELS };
}
let timer = null;
function startLabelRefresh() {
  refreshLabels().catch(() => null);
  if (!timer) { timer = setInterval(() => { refreshLabels().catch(() => null); }, 60000); if (timer.unref) timer.unref(); }
}
// labels: { CODE: 'new words' }. A blank or the built-in word puts the built-in word back. -> { changes:[{code, from, to}] } | { error }
async function saveLabels(labels, byName) {
  await ensure();
  if (!labels || typeof labels !== 'object') return { error: 'Send the stage names to change.' };
  const changes = [];
  const cur = await refreshLabels();
  const next = { ...cur };
  for (const [code, raw] of Object.entries(labels)) { // eslint-disable-line no-restricted-syntax
    if (!DEFAULT_LABELS[code]) return { error: `Unknown stage ${code}. Stages can be renamed, never added or removed.` };
    const label = txt(raw, 60) || DEFAULT_LABELS[code];
    if (label.length < 2) return { error: 'A stage name needs at least 2 letters.' };
    next[code] = label;
    if (label !== cur[code]) changes.push({ code, from: cur[code], to: label });
  }
  const seen = new Map();
  for (const [code, label] of Object.entries(next)) { // eslint-disable-line no-restricted-syntax
    const k = String(label).toLowerCase();
    if (seen.has(k)) return { error: `"${label}" would be the name of two stages (${seen.get(k)} and ${code}). Two stages cannot share a name.` };
    seen.set(k, code);
  }
  for (const c of changes) { // eslint-disable-line no-restricted-syntax
    if (c.to === DEFAULT_LABELS[c.code]) {
      await prisma.$executeRawUnsafe('DELETE FROM "AtsStageLabel" WHERE "code" = ?', c.code); // eslint-disable-line no-await-in-loop
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('INSERT INTO "AtsStageLabel" ("code","label","byName","at") VALUES (?,?,?,?) ON CONFLICT("code") DO UPDATE SET "label"=excluded."label","byName"=excluded."byName","at"=excluded."at"',
        c.code, c.to, byName || null, now());
    }
  }
  await refreshLabels();
  return { changes };
}
async function resetLabels() {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "code","label" FROM "AtsStageLabel"');
  await prisma.$executeRawUnsafe('DELETE FROM "AtsStageLabel"');
  await refreshLabels();
  return rows.map((r) => ({ code: r.code, from: r.label, to: DEFAULT_LABELS[r.code] }));
}

// ---------------------------------------------------------------- sub-statuses
const shapeSub = (r) => ({ id: r.id, stage: r.stage, label: r.label, order: Number(r.sortOrder) || 0, active: Number(r.active) === 1, byName: r.byName || null, at: r.at });
async function subStatuses({ all = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "AtsSubStatus" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "stage", "sortOrder", "label"`);
  return rows.map(shapeSub);
}
async function subStatus(id) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsSubStatus" WHERE "id" = ?', String(id || ''));
  return r ? shapeSub(r) : null;
}
// body { stage, label, order } -> { value } | { error }
function cleanSub(body, before = null) {
  const b = body || {};
  const stage = before ? before.stage : String(b.stage || '');
  if (!V.ALL_STAGE_CODES.includes(stage)) return { error: 'Pick the stage this sub-status sits under.' };
  const label = b.label !== undefined ? txt(b.label, 60) : (before && before.label);
  if (!label || label.length < 2) return { error: 'Enter the sub-status name (at least 2 letters).' };
  const order = b.order !== undefined && b.order !== '' && Number.isFinite(Number(b.order)) ? Math.max(0, Math.min(999, Math.round(Number(b.order)))) : (before ? before.order : null);
  const active = b.active !== undefined ? !!b.active : (before ? before.active : true);
  return { value: { stage, label, order, active } };
}
async function addSub(value, byName) {
  await ensure();
  const list = (await subStatuses({ all: true })).filter((s) => s.stage === value.stage);
  if (list.some((s) => s.label.toLowerCase() === value.label.toLowerCase())) return { error: `"${value.label}" is already a sub-status of ${V.stageLabel(value.stage)}.` };
  const order = value.order != null ? value.order : (list.reduce((m, s) => Math.max(m, s.order), 0) + 1);
  const id = `ss_${crypto.randomBytes(6).toString('hex')}`;
  await prisma.$executeRawUnsafe('INSERT INTO "AtsSubStatus" ("id","stage","label","sortOrder","active","byName","at") VALUES (?,?,?,?,?,?,?)',
    id, value.stage, value.label, order, value.active ? 1 : 0, byName || null, now());
  return { value: await subStatus(id) };
}
async function updateSub(id, value, byName) {
  await ensure();
  const list = (await subStatuses({ all: true })).filter((s) => s.stage === value.stage && s.id !== id);
  if (list.some((s) => s.label.toLowerCase() === value.label.toLowerCase())) return { error: `"${value.label}" is already a sub-status of ${V.stageLabel(value.stage)}.` };
  await prisma.$executeRawUnsafe('UPDATE "AtsSubStatus" SET "label"=?,"sortOrder"=?,"active"=?,"byName"=?,"at"=? WHERE "id"=?',
    value.label, value.order != null ? value.order : 0, value.active ? 1 : 0, byName || null, now(), id);
  return { value: await subStatus(id) };
}
// A sub-status in use is switched off (kept for the history); one never used is removed.
async function removeSub(id) {
  await ensure();
  const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AppSubStatus" WHERE "subStatusId" = ?', id);
  const [{ m }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS m FROM "AppSubStatusLog" WHERE "toLabel" IN (SELECT "label" FROM "AtsSubStatus" WHERE "id" = ?)', id);
  if (Number(n) || Number(m)) {
    await prisma.$executeRawUnsafe('UPDATE "AtsSubStatus" SET "active" = 0, "at" = ? WHERE "id" = ?', now(), id);
    return { switchedOff: true };
  }
  await prisma.$executeRawUnsafe('DELETE FROM "AtsSubStatus" WHERE "id" = ?', id);
  return { removed: true };
}
async function resetSubs() {
  await ensure();
  const all = await subStatuses({ all: true });
  await prisma.$executeRawUnsafe('UPDATE "AtsSubStatus" SET "active" = 0, "at" = ?', now());
  return all.filter((s) => s.active).length;
}

// The CURRENT sub-status of each application: only the one set at the stage the application is at now.
// apps: [{ id, stage }] -> Map(applicationId -> { id, label, order, byName, at })
async function subStatusMap(apps) {
  const list = (apps || []).filter((a) => a && a.id);
  if (!list.length) return new Map();
  await ensure();
  const out = new Map();
  const stageOf = new Map(list.map((a) => [a.id, a.stage]));
  const ids = [...stageOf.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT a."applicationId", a."stage", a."byName", a."at", s."id", s."label", s."sortOrder" FROM "AppSubStatus" a JOIN "AtsSubStatus" s ON s."id" = a."subStatusId" WHERE a."applicationId" IN (${part.map(() => '?').join(',')})`, ...part);
    rows.forEach((r) => {
      if (stageOf.get(r.applicationId) !== r.stage) return;
      out.set(r.applicationId, { id: r.id, label: r.label, order: Number(r.sortOrder) || 0, byName: r.byName || null, at: r.at });
    });
  }
  return out;
}
async function attachSubStatus(apps) {
  const m = await subStatusMap(apps).catch(() => new Map());
  (apps || []).forEach((a) => { if (a) a.subStatus = m.get(a.id) || null; });
  return apps;
}
// The application ids whose CURRENT sub-status is this one (the list filter).
async function applicationIdsWithSub(subStatusId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "applicationId", "stage" FROM "AppSubStatus" WHERE "subStatusId" = ?', String(subStatusId));
  if (!rows.length) return [];
  const apps = await prisma.application.findMany({ where: { id: { in: rows.map((r) => r.applicationId) } }, select: { id: true, stage: true } });
  const want = new Map(rows.map((r) => [r.applicationId, r.stage]));
  return apps.filter((a) => want.get(a.id) === a.stage).map((a) => a.id);
}
// Sets (or clears, sub = null) the sub-status of an application at its current stage, with the timeline row.
async function setAppSub(app, sub, user) {
  await ensure();
  const before = (await subStatusMap([app])).get(app.id) || null;
  if ((before && before.id) === (sub && sub.id)) return { unchanged: true, before, after: before };
  if (sub) {
    await prisma.$executeRawUnsafe('INSERT INTO "AppSubStatus" ("applicationId","subStatusId","stage","byId","byName","at") VALUES (?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "subStatusId"=excluded."subStatusId","stage"=excluded."stage","byId"=excluded."byId","byName"=excluded."byName","at"=excluded."at"',
      app.id, sub.id, app.stage, user && user.id, user && user.name, now());
  } else {
    await prisma.$executeRawUnsafe('DELETE FROM "AppSubStatus" WHERE "applicationId" = ?', app.id);
  }
  await prisma.$executeRawUnsafe('INSERT INTO "AppSubStatusLog" ("applicationId","stage","fromLabel","toLabel","byId","byName","at") VALUES (?,?,?,?,?,?,?)',
    app.id, app.stage, before ? before.label : null, sub ? sub.label : null, user && user.id, user && user.name, now());
  return { before, after: sub ? { id: sub.id, label: sub.label } : null };
}
// The timeline rows of these applications: [{ applicationId, stage, fromLabel, toLabel, byName, at }]
async function subStatusLog(applicationIds) {
  const ids = (applicationIds || []).filter(Boolean);
  if (!ids.length) return [];
  await ensure();
  return prisma.$queryRawUnsafe(`SELECT * FROM "AppSubStatusLog" WHERE "applicationId" IN (${ids.map(() => '?').join(',')}) ORDER BY "id"`, ...ids);
}

// ---------------------------------------------------------------- the share checklist
const SHARE_ITEMS = [
  { key: 'resume', label: 'Resume attached and current' },
  { key: 'ctc', label: 'Current and expected CTC filled' },
  { key: 'notice', label: 'Notice period filled' },
  { key: 'consent', label: 'Candidate agreed to share the profile with this client' },
  { key: 'contact', label: 'Phone / email verified' },
  { key: 'template', label: 'Industry checklist: the "Interview" items' },
];
const SETTING_KEY = 'ats.shareChecklist';
async function checklistSettings() {
  const on = Object.fromEntries(SHARE_ITEMS.map((i) => [i.key, true]));
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const saved = row ? JSON.parse(row.value) : {};
    SHARE_ITEMS.forEach((i) => { if (saved[i.key] === false) on[i.key] = false; });
  } catch { /* defaults */ }
  return on;
}
async function saveChecklistSettings(body) {
  const cur = await checklistSettings();
  const next = { ...cur };
  SHARE_ITEMS.forEach((i) => { if (body && body[i.key] !== undefined) next[i.key] = !!body[i.key]; });
  const v = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: v }, update: { value: v } });
  return { before: cur, after: next };
}
async function resetChecklistSettings() {
  const before = await checklistSettings();
  await prisma.appSetting.deleteMany({ where: { key: SETTING_KEY } });
  return { before, after: await checklistSettings() };
}
const blank = (v) => v == null || String(v).trim() === '' || /^(n\/?a|-|—|none|not known)$/i.test(String(v).trim());

// What the share needs for THIS application: [{ key, label, fact, factOk }] (fact: what the app found on file).
// existing: an application with { id, candidateId, candidate, requirement: { id, department, client } }.
async function shareChecklistFor(existing) {
  const on = await checklistSettings();
  const c = existing.candidate || {};
  const items = [];
  if (on.resume) {
    const [res, doc] = await Promise.all([
      prisma.candidateResume.findFirst({ where: { candidateId: existing.candidateId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null),
      prisma.candidateDocument.findFirst({ where: { candidateId: existing.candidateId, docType: 'Resume', deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null),
    ]);
    const at = [res && res.createdAt, doc && doc.createdAt].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const has = !!at || !!c.resumeName;
    const days = at ? Math.floor((Date.now() - new Date(at).getTime()) / 86400000) : null;
    items.push({ key: 'resume', label: 'Resume attached and current', factOk: has, fact: has ? (days != null ? `on file, ${days === 0 ? 'added today' : `added ${days} day${days === 1 ? '' : 's'} ago`}` : 'on file') : 'no resume on file' });
  }
  if (on.ctc) {
    const missing = require('./salaryFit').missingOf(c); // eslint-disable-line global-require
    items.push({ key: 'ctc', label: 'Current and expected CTC filled', factOk: !missing, fact: missing ? `${missing === 'both' ? 'current and expected' : missing} CTC not filled` : 'both filled' });
  }
  if (on.notice) {
    const ok = !blank(c.noticePeriod);
    items.push({ key: 'notice', label: 'Notice period filled', factOk: ok, fact: ok ? String(c.noticePeriod) : 'not filled' });
  }
  if (on.consent) {
    items.push({ key: 'consent', label: 'Candidate agreed to share the profile with this client', factOk: true, fact: c.consentStatus === 'GIVEN' ? 'consent recorded' : null });
  }
  if (on.contact) {
    const ok = !blank(c.phone) || !blank(c.email);
    items.push({ key: 'contact', label: 'Phone / email verified', factOk: ok, fact: ok ? null : 'no phone or email on file' });
  }
  if (on.template && existing.requirement) {
    const X = require('./atsOfferBgv'); // eslint-disable-line global-require
    const req = existing.requirement.client ? existing.requirement : await prisma.requirement.findUnique({ where: { id: existing.requirementId }, include: { client: true } });
    const ind = await X.requirementExtras(req).catch(() => null);
    const tpl = ind && ind.template;
    if (tpl) {
      const done = await X.checklistOf(existing.id, tpl);
      done.filter((it) => it.step === 'Interview' && it.required).forEach((it) => {
        items.push({ key: `tpl:${it.key}`, label: `${tpl.industry}: ${it.label}`, factOk: true, fact: it.done ? `ticked${it.byName ? ` by ${it.byName}` : ''}` : null, ticked: it.done, templateKey: it.key });
      });
    }
  }
  return items;
}
// The share is a first share (the profile was never in front of the client) on a client job.
const AFTER_SHARE = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
function needsShareChecklist(existing, stage) {
  return ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(stage) && !AFTER_SHARE.includes(existing.stage)
    && !!existing.requirement && !existing.requirement.internal
    && !(existing.requirement.client && existing.requirement.client.clientType === 'Internal');
}
// ticks: { resume: true, ctc: true, 'tpl:reg_number': true, ... } -> null | { status, body }.
// On a pass, the template items ticked here are saved on the application's industry checklist.
async function shareChecklistProblem(existing, ticks, user) {
  const items = await shareChecklistFor(existing);
  if (!items.length) return null;
  const t = ticks && typeof ticks === 'object' ? ticks : {};
  const missing = [];
  items.forEach((it) => {
    const ticked = t[it.key] === true || t[it.key] === 'true' || it.ticked === true;
    if (!it.factOk) missing.push({ key: it.key, label: it.label, why: it.fact });
    else if (!ticked) missing.push({ key: it.key, label: it.label, why: 'not ticked' });
  });
  if (missing.length) {
    const who = existing.candidate ? existing.candidate.name : 'this person';
    return {
      status: 409,
      body: {
        code: 'SHARE_CHECKLIST',
        error: `Before ${who} goes to the client, finish the checklist: ${missing.map((m) => `${m.label}${m.why && m.why !== 'not ticked' ? ` (${m.why})` : ''}`).join('; ')}.`,
        missing,
        items,
      },
    };
  }
  const X = require('./atsOfferBgv'); // eslint-disable-line global-require
  for (const it of items) { // eslint-disable-line no-restricted-syntax
    if (it.templateKey && !it.ticked) await X.tick(existing.id, it.templateKey, true, 'Ticked on the share checklist', user && user.name).catch(() => null); // eslint-disable-line no-await-in-loop
  }
  return null;
}

// ---------------------------------------------------------------- fee type
const FEE_TYPES = ['PERCENT_CTC', 'FIXED', 'PER_CANDIDATE', 'SLAB'];
const FEE_TYPE_LABELS = { PERCENT_CTC: '% of CTC', FIXED: 'Fixed amount per joining', PER_CANDIDATE: 'Fixed amount per candidate', SLAB: 'Slab (CTC bands to %)' };
// slabs: [{ upTo: number|null, percent }] sorted by upTo, the last band open (upTo null). -> { value } | { error }
function cleanSlabs(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const s of arr) { // eslint-disable-line no-restricted-syntax
    const upTo = s.upTo === '' || s.upTo == null ? null : Number(s.upTo);
    const percent = Number(s.percent);
    if (upTo != null && !(Number.isFinite(upTo) && upTo > 0)) return { error: 'Each band\'s "CTC up to" must be a yearly amount above 0 (leave the last band blank for "and above").' };
    if (!(Number.isFinite(percent) && percent > 0 && percent <= 50)) return { error: 'Each band\'s fee must be a % between 0 and 50.' };
    out.push({ upTo, percent: Math.round(percent * 100) / 100 });
  }
  if (!out.length) return { error: 'Add at least one band.' };
  out.sort((a, b) => (a.upTo == null ? 1 : b.upTo == null ? -1 : a.upTo - b.upTo)); // eslint-disable-line no-nested-ternary
  if (out.filter((s) => s.upTo == null).length > 1) return { error: 'Only the last band can be "and above".' };
  for (let i = 1; i < out.length; i += 1) if (out[i].upTo != null && out[i].upTo === out[i - 1].upTo) return { error: 'Two bands end at the same CTC.' };
  if (out[out.length - 1].upTo != null) out.push({ upTo: null, percent: out[out.length - 1].percent });
  return { value: out };
}
async function slabsOf(clientId) {
  if (!clientId) return null;
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT "slabs","byName","at" FROM "ClientFeeSlab" WHERE "clientId" = ?', String(clientId));
  if (!r) return null;
  try { return JSON.parse(r.slabs); } catch { return null; }
}
async function slabMap(clientIds) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT "clientId","slabs" FROM "ClientFeeSlab" WHERE "clientId" IN (${ids.map(() => '?').join(',')})`, ...ids);
  return new Map(rows.map((r) => { try { return [r.clientId, JSON.parse(r.slabs)]; } catch { return [r.clientId, null]; } }));
}
async function saveSlabs(clientId, slabs, byName) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "ClientFeeSlab" ("clientId","slabs","byName","at") VALUES (?,?,?,?) ON CONFLICT("clientId") DO UPDATE SET "slabs"=excluded."slabs","byName"=excluded."byName","at"=excluded."at"',
    String(clientId), JSON.stringify(slabs), byName || null, now());
}
const slabPercent = (slabs, ctc) => {
  if (!Array.isArray(slabs) || !slabs.length || !(Number(ctc) > 0)) return null;
  const band = slabs.find((s) => s.upTo == null || Number(ctc) <= Number(s.upTo));
  return band ? Number(band.percent) : null;
};
const slabText = (slabs) => (Array.isArray(slabs) ? slabs.map((s, i) => (s.upTo == null ? `above ${i ? `₹${Number(slabs[i - 1].upTo).toLocaleString('en-IN')}` : '0'}: ${s.percent}%` : `up to ₹${Number(s.upTo).toLocaleString('en-IN')}: ${s.percent}%`)).join(' · ') : '');

// THE FEE OF ONE JOINING, from the client's agreement. override = a commission % set for this joining (the Joined popup).
// -> { feeType, amount (null = waits for the CTC), feePercent (null on a fixed fee), basis (words for the audit / notes) }
function feeFor(client, ctc, { slabs = null, override = null } = {}) {
  const c = client || {};
  const hasCtc = Number(ctc) > 0;
  const agreed = c.agreementFeePercent != null ? Number(c.agreementFeePercent) : V.DEFAULT_FEE_PERCENT;
  if (override != null && Number(override) > 0) {
    return { feeType: 'PERCENT_CTC', feePercent: Number(override), amount: hasCtc ? Math.round((Number(ctc) * Number(override)) / 100) : null, basis: `Commission ${override}% set at joining` };
  }
  const type = FEE_TYPES.includes(c.feeType) ? c.feeType : 'PERCENT_CTC';
  if ((type === 'FIXED' || type === 'PER_CANDIDATE') && Number(c.feeAmount) > 0) {
    return { feeType: type, feePercent: null, amount: Math.round(Number(c.feeAmount)), basis: `${FEE_TYPE_LABELS[type]}: ₹${Number(c.feeAmount).toLocaleString('en-IN')}` };
  }
  if (type === 'SLAB' && Array.isArray(slabs) && slabs.length) {
    const pct = slabPercent(slabs, ctc);
    if (pct == null) return { feeType: 'SLAB', feePercent: null, amount: null, basis: `Slab fee (${slabText(slabs)}): waits for the CTC` };
    return { feeType: 'SLAB', feePercent: pct, amount: Math.round((Number(ctc) * pct) / 100), basis: `Slab fee: ${pct}% for a CTC of ₹${Number(ctc).toLocaleString('en-IN')} (${slabText(slabs)})` };
  }
  return { feeType: 'PERCENT_CTC', feePercent: agreed, amount: hasCtc ? Math.round((Number(ctc) * agreed) / 100) : null, basis: `${agreed}% of CTC` };
}

module.exports = {
  ensure, DEFAULT_LABELS, refreshLabels, labelsFresh, startLabelRefresh, saveLabels, resetLabels,
  subStatuses, subStatus, cleanSub, addSub, updateSub, removeSub, resetSubs, subStatusMap, attachSubStatus, applicationIdsWithSub, setAppSub, subStatusLog,
  SHARE_ITEMS, checklistSettings, saveChecklistSettings, resetChecklistSettings, shareChecklistFor, needsShareChecklist, shareChecklistProblem,
  FEE_TYPES, FEE_TYPE_LABELS, cleanSlabs, slabsOf, slabMap, saveSlabs, slabPercent, slabText, feeFor,
};
