// ---------------------------------------------------------------------------
// THE AGREEMENT PREPARATION WORKFLOW  (user, 2026-10-13)
//
//   Draft (BDE)  >  With Purna Sir (HR: sections 6-9)  >  With BDE TL (cross-check)
//        >  Sent to client  >  Signed  >  Active
//
// BDE / BDE desk fill ONLY the commercial part (sections 1-5) and click "Send to Purna Sir".
// Purna Sir (Internal HR TL, employee id TL309) fills 6 Tax & billing, 7 Payment details, 8 Documents,
// 9 Internal notes and clicks "Send to BDE TL". The BDE TL checks EVERYTHING and clicks "Send to client"
// (an Admin / Super Admin may too). Only "Send to client" makes / sends the client link.
//
// NO SCHEMA CHANGE. The step lives in one AppSetting row per client (key "agrwf:<clientId>", JSON
// { stage, history[], hrTaskId, tlTaskId }). A client with no row, and every client whose agreementStatus
// is not DRAFT, is read from its OLD status (SENT / SIGNED / ACTIVE ...), so old agreements keep working.
//
// Who may do what (one place - routes read these answers, the screen only draws them):
//   sections 6-9 are READ by: Super Admin / Admin, the BDE TL, the HR approver, and (as before) Manager,
//     Assistant Manager, Accounts - NEVER the BDE desk (redactFor). They are WRITTEN by the HR approver
//     while the step is "With Purna Sir", and by Admin / Super Admin any time. Nobody else, ever.
//   sections 1-5 are written by the BDE desk / BDE TL while the step is Draft; while it is with Purna Sir or
//     the BDE TL they are locked (Admin can still edit = unlock).
//   the HR approver: employee ids in the setting "Agreement HR approver(s)" (default TL309). Any HR-desk login
//     is an approver only when that setting also says "HR desk".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const scope = require('./scope');
const { logAudit } = require('./audit');

const SETTINGS_KEY = 'agreementWorkflow';
const PREFIX = 'agrwf:';
const DEFAULTS = { approvers: ['TL309'], allowHrDesk: false, hrLabel: 'HR' };

const STAGES = ['DRAFT', 'WITH_HR', 'WITH_TL', 'SENT', 'SIGNED', 'ACTIVE'];
const TAX_KEYS = ['legalName', 'billingAddress', 'billingSameAsAddress', 'gst', 'pan', 'tan', 'billingEmail', 'invoiceEmail',
  'billingContactName', 'billingContactDesignation', 'billingContactPhone', 'billingContactEmail'];
const PAYMENT_KEYS = ['paymentMethod', 'paymentBankName', 'paymentUpi', 'paymentReferenceNote', 'bankAccountHolder', 'bankAccountNo',
  'bankAccountNoEnc', 'bankAccountLast4', 'bankAccountMasked', 'bankIfsc'];
const NOTES_KEYS = ['internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks'];
// every field that belongs to sections 6, 7 and 9 (section 8 = documents, guarded on its own routes)
const HR_KEYS = [...TAX_KEYS, ...PAYMENT_KEYS, ...NOTES_KEYS];
// keys that a LIST row may carry; what the BDE desk must never read
const HR_READ_KEYS = HR_KEYS.concat(['bankAccountNo']);

// ---- settings ---------------------------------------------------------------
let sCache = null;
let sAt = 0;
async function settings({ fresh = false } = {}) {
  if (!fresh && sCache && Date.now() - sAt < 10000) return sCache;
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let o = {};
  try { o = row && row.value ? JSON.parse(row.value) : {}; } catch { o = {}; }
  const approvers = Array.isArray(o.approvers) ? o.approvers.map((x) => String(x).trim()).filter(Boolean) : DEFAULTS.approvers;
  sCache = {
    approvers: [...new Set(approvers)],
    allowHrDesk: o.allowHrDesk === true,
    // 2026-10-16 (user): no person's name on the buttons - a label saved earlier with a name reads "HR".
    hrLabel: (/purna/i.test(String(o.hrLabel || '')) ? '' : String(o.hrLabel || '')).trim().slice(0, 40) || DEFAULTS.hrLabel,
    updatedAt: row ? row.updatedAt : null,
    updatedByName: row ? row.updatedByName : null,
  };
  sAt = Date.now();
  return sCache;
}
async function saveSettings(patch, user) {
  const cur = await settings({ fresh: true });
  const next = { approvers: cur.approvers, allowHrDesk: cur.allowHrDesk, hrLabel: cur.hrLabel };
  const p = patch || {};
  if (p.approvers !== undefined) {
    const list = (Array.isArray(p.approvers) ? p.approvers : String(p.approvers).split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);
    if (list.some((x) => !/^[A-Za-z0-9_-]{2,40}$/.test(x))) return { error: 'An employee ID has letters and numbers only, like TL309.' };
    next.approvers = [...new Set(list)];
  }
  if (p.allowHrDesk !== undefined) next.allowHrDesk = p.allowHrDesk === true;
  if (p.hrLabel !== undefined) next.hrLabel = String(p.hrLabel || '').trim().slice(0, 40) || DEFAULTS.hrLabel;
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value: JSON.stringify(next), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
  sCache = null;
  return { settings: await settings({ fresh: true }), before: cur };
}

// ---- who is who ---------------------------------------------------------------
const isAdmin = (user) => {
  try { return scope.atsViewRole(user) === 'admin'; } catch { return false; }
};
function isHrApproverSync(user, cfg) {
  if (!user) return false;
  if (cfg.approvers.some((a) => a.toUpperCase() === String(user.employeeCode || '').toUpperCase())) return true;
  return !!(cfg.allowHrDesk && user.hrDesk);
}
async function rolesOf(user) {
  const cfg = await settings();
  const admin = isAdmin(user);
  let bdeTl = false;
  try { bdeTl = scope.isBdeTl(user); } catch { bdeTl = false; }
  let desk = false;
  try { desk = scope.atsViewRole(user) === 'bde' && !bdeTl && !admin; } catch { desk = false; }
  return { admin, bdeTl, bdeDesk: desk, hr: isHrApproverSync(user, cfg) && !admin, cfg };
}
// does this login read the HR sections at all? (sync - used by every client payload)
// Only the BDE desk is cut off; everyone else keeps what the clients module already gave them.
function hidesHrFor(user) {
  try {
    if (!user) return false;
    return scope.atsViewRole(user) === 'bde' && !scope.isBdeTl(user) && !isAdmin(user);
  } catch { return false; }
}
// remove sections 6-9 from a client payload for the BDE desk (in place; returns the object)
function redactFor(user, out) {
  if (!out || !hidesHrFor(user)) return out;
  HR_READ_KEYS.forEach((k) => { delete out[k]; });
  out.hrSectionsHidden = true;
  return out;
}

// ---- stage -------------------------------------------------------------------
async function loadRow(clientId) {
  const row = await prisma.appSetting.findUnique({ where: { key: PREFIX + clientId } }).catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
async function loadRows(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } } }).catch(() => []);
  const want = new Set(ids);
  rows.forEach((r) => {
    const id = r.key.slice(PREFIX.length);
    if (!want.has(id)) return;
    try { out.set(id, JSON.parse(r.value)); } catch { /* skip */ }
  });
  return out;
}
async function saveRow(clientId, wf, user) {
  const value = JSON.stringify(wf);
  await prisma.appSetting.upsert({
    where: { key: PREFIX + clientId },
    create: { key: PREFIX + clientId, value, updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
}
const OLD = {
  DRAFT: 'DRAFT', SENT: 'SENT', VIEWED: 'SENT', CLIENT_CONFIRMATION_PENDING: 'SENT', CONFIRMED: 'SIGNED', SIGNED: 'SIGNED',
  ACTIVE: 'ACTIVE', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED', CANCELLED: 'REJECTED',
};
// The step of a client. Anything but a Draft agreement is read from its old status.
function stageOf(client, wf) {
  const st = OLD[String((client && client.agreementStatus) || 'DRAFT').toUpperCase()] || 'DRAFT';
  if (st !== 'DRAFT') return st;
  const s = wf && wf.stage;
  return s === 'WITH_HR' || s === 'WITH_TL' ? s : 'DRAFT';
}
function labelOf(stage, cfg) {
  const hr = (cfg && cfg.hrLabel) || DEFAULTS.hrLabel;
  return ({
    DRAFT: 'With the BDE', WITH_HR: `With ${hr}`, WITH_TL: 'With BDE TL', SENT: 'Sent to client', SIGNED: 'Signed', ACTIVE: 'Active',
    REJECTED: 'Sent back by client', EXPIRED: 'Expired',
  })[stage] || 'With the BDE';
}
const colourOf = (stage) => ({ DRAFT: 'orange', WITH_HR: 'orange', WITH_TL: 'blue', SENT: 'blue', SIGNED: 'green', ACTIVE: 'green', REJECTED: 'red', EXPIRED: 'red' })[stage] || 'orange';

// ---- required fields ------------------------------------------------------------
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
// Section 6 must have these before HR can send it on.
function missingTax(client) {
  const m = [];
  if (blank(client.legalName)) m.push('Legal company name');
  if (blank(client.gst) && blank(client.pan)) m.push('GSTIN or PAN');
  if (blank(client.invoiceEmail) && blank(client.billingEmail)) m.push('Email to send invoices to');
  return m;
}

// ---- what a login may do on one client ------------------------------------------
async function rightsFor(user, client, wf) {
  const r = await rolesOf(user);
  const stage = stageOf(client, wf);
  const pre = ['DRAFT', 'WITH_HR', 'WITH_TL'].includes(stage);
  const draftish = stage === 'DRAFT' || stage === 'REJECTED' || stage === 'EXPIRED';
  const bdeSide = r.bdeDesk || r.bdeTl;
  return {
    roles: { admin: r.admin, bdeTl: r.bdeTl, bdeDesk: r.bdeDesk, hr: r.hr },
    stage,
    seesHr: r.admin || r.bdeTl || r.hr || !hidesHrFor(user),
    // sections 6-9: HR while with Purna Sir; Admin any time
    editHr: r.admin || (r.hr && stage === 'WITH_HR'),
    // sections 1-5: the BDE desk while Draft; the BDE TL while Draft and while it is with them (their own step);
    // locked for the one who already sent it on; Admin any time
    editCommercial: r.admin || (r.bdeDesk && (stage === 'DRAFT' || !pre)) || (r.bdeTl && (stage === 'DRAFT' || stage === 'WITH_TL' || !pre)),
    lockedCommercial: pre && !r.admin && !((r.bdeDesk && stage === 'DRAFT') || (r.bdeTl && (stage === 'DRAFT' || stage === 'WITH_TL'))),
    can: {
      sendToHr: (bdeSide || r.admin) && draftish && stage !== 'WITH_HR',
      sendToTl: (r.hr || r.admin) && stage === 'WITH_HR',
      backToBdeFromHr: (r.hr || r.admin) && stage === 'WITH_HR',
      backToBdeFromTl: (r.bdeTl || r.admin) && stage === 'WITH_TL',
      backToHr: (r.bdeTl || r.admin) && stage === 'WITH_TL',
      sendToClient: (r.bdeTl || r.admin) && stage === 'WITH_TL',
      // an Admin can also send straight from Draft / with Purna Sir (audited as an Admin override)
      adminOverrideSend: r.admin && (stage === 'DRAFT' || stage === 'WITH_HR'),
    },
  };
}

// Gate for POST /clients/:id/agreement/send. Returns a refusal sentence, or null.
async function sendGate(user, client, body) {
  const wf = await loadRow(client.id);
  const stage = stageOf(client, wf);
  if (!['DRAFT', 'WITH_HR', 'WITH_TL'].includes(stage)) return null; // a re-send of a link that already went out: unchanged
  const r = await rolesOf(user);
  if (r.admin) return null;
  if (!r.bdeTl) return 'Only the BDE team lead or an Admin sends the agreement to the client.';
  if (stage !== 'WITH_TL') {
    return stage === 'WITH_HR'
      ? `It is with ${r.cfg.hrLabel} now. It reaches you after ${r.cfg.hrLabel} fills Tax & billing and sends it on.`
      : `It is not sent yet. The BDE sends it to ${r.cfg.hrLabel} first.`;
  }
  const v = body && body.verified;
  const need = ['commercial', 'tax', 'payment', 'documents'];
  const got = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).filter((k) => v[k]) : []);
  if (need.some((k) => !got.includes(k))) return 'Tick that you checked the commercial terms, tax & billing, payment details and documents, then send.';
  return null;
}

// ---- people to tell --------------------------------------------------------------
async function approverUsersAll(cfg) {
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: cfg.approvers }, userId: { not: null } }, select: { userId: true, name: true } }).catch(() => []);
  const out = emps.map((e) => ({ id: e.userId, name: e.name }));
  if (cfg.allowHrDesk) {
    // every HR-desk login: resolved lazily from the employees of Internal HR
    const more = await prisma.employee.findMany({ where: { department: { in: ['Internal HR', 'HR'] }, userId: { not: null }, employmentStatus: { notIn: ['Relieved', 'Exited'] } }, select: { userId: true, name: true } }).catch(() => []);
    more.forEach((e) => { if (!out.some((o) => o.id === e.userId)) out.push({ id: e.userId, name: e.name }); });
  }
  return out;
}
async function bdeTlUsers() {
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ atsRole: 'TL' }, { role: 'TL' }], AND: [{ OR: [{ atsDepartment: 'BDE' }, { atsScopeDepartments: { contains: 'BDE' } }] }] },
    select: { id: true, name: true, email: true },
  }).catch(() => []);
  return users;
}
async function adminUsers() {
  return prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, name: true } }).catch(() => []);
}
async function userByName(name) {
  if (!name) return null;
  return prisma.user.findFirst({ where: { name: String(name).trim() }, select: { id: true, name: true } }).catch(() => null);
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
async function openTask({ assignee, by, name, description, days = 2 }) {
  if (!assignee) return null;
  const due = new Date(Date.now() + days * 86400000);
  try {
    const t = await prisma.task.create({
      data: {
        name: String(name).slice(0, 190), department: null, description: String(description).slice(0, 1000), status: 'Not Started', priority: 'High',
        startDate: ymd(new Date()), endDate: ymd(due),
        assigneeId: assignee.id, assignedById: by.id, assigneeName: assignee.name || 'Team member', assignedByName: by.name || 'TeamLink',
      },
    });
    return t.id;
  } catch { return null; }
}
async function closeTask(id) {
  if (!id) return;
  await prisma.task.updateMany({ where: { id, status: { in: ['Not Started', 'In Progress', 'On Hold'] } }, data: { status: 'Completed', completedAt: new Date() } }).catch(() => {});
}
// The bell goes straight to the notification table: HR must not lose these to the "agreement" word filter, so the
// titles / lines for the HR step never say "agreement".
async function bell(users, title, message, exceptId) {
  const ids = [...new Set((users || []).map((u) => (u && u.id) || u).filter((x) => x && x !== exceptId))];
  await Promise.all(ids.map((userId) => prisma.notification.create({ data: { userId, title: String(title).slice(0, 190), message: String(message || '').slice(0, 500), channel: 'In-App', status: 'Sent' } }).catch(() => null)));
  return ids.length;
}

// ---- the moves ---------------------------------------------------------------------
const fail = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) });

// action: send_to_hr | send_to_tl | back_to_bde | back_to_hr     (send to client = POST /clients/:id/agreement/send)
async function move(user, client, action, body = {}) {
  const wf = (await loadRow(client.id)) || { history: [] };
  const rights = await rightsFor(user, client, wf);
  const cfg = rights.roles && (await settings());
  const stage = rights.stage;
  const reason = String(body.reason || '').trim().slice(0, 500);
  const hrName = cfg.hrLabel;
  let to; let from = stage; let label;
  if (action === 'send_to_hr') {
    if (!rights.can.sendToHr) return fail(403, stage === 'WITH_HR' ? `It is already with ${hrName}.` : 'You cannot send this one now.');
    const miss = require('./clientProfile').missingRequired(client).map((m) => m.label);
    if (miss.length) return fail(400, `Fill these first: ${miss.join(', ')}.`, { missing: miss });
    // no agreement text yet (a client saved as a plain draft): make it from the template, exactly as Save & create agreement does
    if (blank(client.agreementDocument)) {
      try {
        const A = require('./agreement'); // eslint-disable-line global-require
        const vendor = require('./vendorAgreement'); // eslint-disable-line global-require
        const madeOn = vendor.effectiveYmd(client);
        const made = await prisma.client.update({
          where: { id: client.id },
          data: {
            agreementStart: madeOn, agreementDocument: A.buildAgreementDocument({ ...client, agreementStart: madeOn }, await A.consultantParty()),
            agreementSource: 'Generated', agreementId: client.agreementId || (await A.nextAgreementId()),
          },
        });
        Object.assign(client, made);
      } catch { return fail(500, 'The agreement could not be made. Please try again.'); }
    }
    to = 'WITH_HR'; label = `Sent to ${hrName}`;
  } else if (action === 'send_to_tl') {
    if (!rights.can.sendToTl) return fail(403, 'You cannot send this one now.');
    const miss = missingTax(client);
    if (miss.length) return fail(400, `Fill these in Tax & billing first: ${miss.join(', ')}.`, { missing: miss });
    to = 'WITH_TL'; label = 'Sent to the BDE team lead';
  } else if (action === 'back_to_bde') {
    if (!(rights.can.backToBdeFromHr || rights.can.backToBdeFromTl)) return fail(403, 'You cannot send this one back now.');
    if (!reason) return fail(400, 'Write why you are sending it back, in a few words.', { needReason: true });
    to = 'DRAFT'; label = 'Sent back to the BDE';
  } else if (action === 'back_to_hr') {
    if (!rights.can.backToHr) return fail(403, 'You cannot send this one back now.');
    if (!reason) return fail(400, 'Write why you are sending it back, in a few words.', { needReason: true });
    to = 'WITH_HR'; label = `Sent back to ${hrName}`;
  } else return fail(400, 'That action is not known.');

  const entry = { at: new Date().toISOString(), by: user.id, byName: user.name || '', from, to, action, ...(reason ? { reason } : {}) };
  const next = { ...wf, stage: to, history: [...(wf.history || []), entry].slice(-60) };

  // the document is rebuilt with the Tax & billing details just before the BDE TL checks it
  if (action === 'send_to_tl' && client.agreementSource !== 'Uploaded' && !blank(client.agreementDocument)) {
    try {
      const A = require('./agreement'); // eslint-disable-line global-require
      const doc = A.buildAgreementDocument(client, await A.consultantParty());
      await prisma.client.update({ where: { id: client.id }, data: { agreementDocument: doc, agreementSource: 'Generated' } });
    } catch { /* the old text stays */ }
  }
  // the people to tell, and the new to-do
  const nm = client.name;
  const by = { id: user.id, name: user.name };
  await closeTask(wf.hrTaskId); await closeTask(wf.tlTaskId); await closeTask(wf.bdeTaskId);
  next.hrTaskId = null; next.tlTaskId = null; next.bdeTaskId = null;
  let told = 0;
  if (to === 'WITH_HR') {
    const who = await approverUsersAll(cfg);
    told = await bell(who, `Fill Tax & billing for ${nm}`, (reason ? `Sent back by ${user.name}: ${reason}` : `${user.name} sent ${nm}. Open it, fill Tax & billing, Payment details, Documents and Notes, then send it to the BDE team lead.`) + `
Open: /tax-billing/${client.id}`, user.id);
    next.hrTaskId = await openTask({ assignee: who[0], by, name: `Fill Tax & billing for ${nm}`, description: `${nm} is waiting for you. Fill Tax & billing (and Payment details, Documents, Notes), then press Send to BDE TL.` });
    if (who.length > 1) await Promise.all(who.slice(1).map((w) => openTask({ assignee: w, by, name: `Fill Tax & billing for ${nm}`, description: `${nm} is waiting for you.` })));
  } else if (to === 'WITH_TL') {
    const who = await bdeTlUsers();
    told = await bell(who, `Agreement for ${nm} is ready to verify`, `${user.name} filled Tax & billing. Check everything, then press Send to client.
Open: /clients/${client.id}?tab=agreement`, user.id);
    next.tlTaskId = await openTask({ assignee: who[0], by, name: `Verify and send ${nm}`, description: `Agreement for ${nm} is ready to verify. Check the commercial terms, tax & billing, payment details and documents, then send it to the client.` });
  } else if (to === 'DRAFT') {
    const owner = await userByName(client.bdeOwner);
    const starter = [...(wf.history || [])].reverse().find((h) => h.action === 'send_to_hr');
    const targets = [owner, starter ? { id: starter.by } : null].filter(Boolean);
    told = await bell(targets, `${nm} was sent back to you`, `${user.name}: ${reason}
Open: /clients/${client.id}?tab=agreement`, user.id);
    next.bdeTaskId = await openTask({ assignee: owner || (starter ? { id: starter.by, name: starter.byName } : null), by, name: `Fix and resend ${nm}`, description: `Sent back by ${user.name}: ${reason}` });
  }
  await saveRow(client.id, next, user);
  await logAudit({
    userId: user.id, action: `Agreement step: ${label}`, entity: 'Client', entityId: client.id, fromValue: labelOf(from, cfg), toValue: labelOf(to, cfg),
    ...(reason ? { reason } : {}),
  });
  return { ok: true, stage: to, label: labelOf(to, cfg), told, wf: next };
}

// After the existing send route made the link: record the step (audited there already).
async function afterSend(user, client) {
  const wf = (await loadRow(client.id)) || { history: [] };
  const cfg = await settings();
  const from = stageOf({ ...client, agreementStatus: 'DRAFT' }, wf);
  await closeTask(wf.tlTaskId); await closeTask(wf.hrTaskId);
  const next = {
    ...wf, stage: 'SENT', tlTaskId: null, hrTaskId: null,
    history: [...(wf.history || []), { at: new Date().toISOString(), by: user.id, byName: user.name || '', from, to: 'SENT', action: 'send_to_client' }].slice(-60),
  };
  await saveRow(client.id, next, user);
  const owner = await userByName(client.bdeOwner);
  await bell([owner].filter(Boolean), `${client.name} was sent to the client`, `${user.name} sent the link.`, user.id);
  void cfg;
}

// ---- the lists -----------------------------------------------------------------------
// Which step waits for this login? 'WITH_HR' for the HR approver, 'WITH_TL' for the BDE TL, 'DRAFT' for the BDE (sent back).
function waitingStagesFor(roles) {
  const s = [];
  if (roles.hr) s.push('WITH_HR');
  if (roles.bdeTl || roles.admin) s.push('WITH_TL');
  if (roles.bdeDesk || roles.bdeTl) s.push('DRAFT_BACK');
  return s;
}
// Decorates client rows with { agreementStage, agreementStageLabel, agreementStageColour, agreementWaiting }
async function decorate(user, clients) {
  if (!clients || !clients.length) return;
  const [rows, roles] = await Promise.all([loadRows(clients.map((c) => c.id)), rolesOf(user)]);
  const wait = waitingStagesFor(roles);
  clients.forEach((c) => {
    const wf = rows.get(c.id) || null;
    const st = stageOf(c, wf);
    const sentBack = st === 'DRAFT' && wf && (wf.history || []).length && wf.history[wf.history.length - 1].action.startsWith('back_to');
    c.agreementStage = st;
    c.agreementStageLabel = labelOf(st, roles.cfg);
    c.agreementStageColour = colourOf(st);
    c.agreementWaiting = wait.includes(st) || (sentBack && wait.includes('DRAFT_BACK'));
  });
}

module.exports = {
  SETTINGS_KEY, PREFIX, DEFAULTS, STAGES, HR_KEYS, TAX_KEYS, PAYMENT_KEYS, NOTES_KEYS, HR_READ_KEYS,
  settings, saveSettings, rolesOf, hidesHrFor, redactFor, loadRow, loadRows, saveRow, stageOf, labelOf, colourOf,
  missingTax, rightsFor, sendGate, move, afterSend, decorate, approverUsersAll, waitingStagesFor, isHrApproverSync, bell,
};
