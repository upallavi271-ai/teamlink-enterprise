// ---------------------------------------------------------------------------
// OMNI-CHANNEL SHARED TEMPLATE LIBRARY (2026-10-17). ONE library for the whole app. It does NOT copy templates: the words stay in the store that owns them
// (utils/messageTemplates.js = Message templates for ATS / HRMS employees / Accounts reminders; outreach/templates.js = campaign messages; saved jobs and
// job posting texts) and are read through the template hub (outreach/hub.js). This file adds what the hub did not have, in a small table of its own:
//   scopes      which apps may use the template: ATS, Job Portal, HRMS, Accounts, Omni-Channel (default worked out from what the template is; a person who may
//               edit the template can change it)
//   department  the department it belongs to (Admin sets it; empty = for everybody who may use it)
//   approval    approved | waiting | changes. Default approved (nothing in use stops working). Ask for approval at any time; with the library switch
//               "New and changed templates need approval" ON, a template written or changed by somebody who cannot approve waits for an approver.
//   versions    every save is kept (Message templates keeps its own; the others are kept in OmniTemplateVersion), with who and when
//   permissions who may SEE it (the real contact rules of utils/contactAccess.js per kind of person: candidates / clients / employees; Accounts only the payment
//               reminder wording), who may USE it in an app (scope + approval + department) and who may EDIT it (the owner store's own rule)
// canUse() / gate() are what the campaign code calls, so a template that an app may not use is refused by the SERVER, not only hidden by the screen.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('../store');
const A = require('../access');
const Hub = require('../hub');
const MT = require('../../utils/messageTemplates');
const access = require('../../utils/contactAccess');
const Schema = require('./schema');
const { logAudit } = require('../../utils/audit');

const APPS = ['ATS', 'Job Portal', 'HRMS', 'Accounts', 'Omni-Channel'];
const APP_WORDS = { ATS: 'ATS', 'Job Portal': 'Job Portal', HRMS: 'HRMS', Accounts: 'Accounts', 'Omni-Channel': 'Omni-Channel' };
const APPROVAL = { approved: 'Approved', waiting: 'Waiting for approval', changes: 'Changes needed' };
const BILLING = ['CLIENT_PAYMENT_REMINDER', 'CLIENT_INVOICE_NOTICE'];
const PORTAL_PURPOSES = ['JOB_ALERT', 'APPLICATION_RECEIVED', 'BULK_NEW_OPENING'];
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const clip = S.clip;
const isAdmin = (u) => A.isAdmin(u);

// ---- settings --------------------------------------------------------------------------
async function settings() {
  const v = await S.getKey('omni.library', {});
  return { requireApproval: !!v && v.requireApproval === true, requireCampaignApproval: !!v && v.requireCampaignApproval === true };
}
async function saveSettings(user, b) {
  if (!isAdmin(user)) return { error: 'Only an Admin can change the library settings.', status: 403 };
  const cur = await settings();
  const next = {
    requireApproval: b && b.requireApproval !== undefined ? b.requireApproval === true : cur.requireApproval,
    requireCampaignApproval: b && b.requireCampaignApproval !== undefined ? b.requireCampaignApproval === true : cur.requireCampaignApproval,
  };
  await S.putKey('omni.library', next, user);
  if (next.requireApproval !== cur.requireApproval) {
    await logAudit({ userId: user.id, actorName: user.name, action: next.requireApproval ? 'Template library: approval required for new and changed templates' : 'Template library: approval not required', entity: 'OmniTemplateLibrary', entityId: 'settings', toValue: next.requireApproval ? 'on' : 'off' });
  }
  if (next.requireCampaignApproval !== cur.requireCampaignApproval) {
    await logAudit({ userId: user.id, actorName: user.name, action: next.requireCampaignApproval ? 'App campaigns: approval required before sending' : 'App campaigns: approval not required', entity: 'OmniTemplateLibrary', entityId: 'settings', toValue: next.requireCampaignApproval ? 'on' : 'off' });
  }
  return { ok: 'Saved.', settings: next };
}

// ---- what a template is (read straight from the owning store) ------------------------------
const varsIn = (...texts) => [...new Set(texts.flatMap((t) => [...String(t || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1].trim()).filter(Boolean)))];
const splitKey = (key) => { const s = String(key || ''); const i = s.indexOf(':'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };

// { key, source, audience, purpose, label, name, channel, subject, body, language } or null
async function raw(key) {
  const [source, id] = splitKey(key);
  try {
    if (source === 'message' && MT.supported()) {
      const r = await prisma.messageTemplate.findUnique({ where: { id } });
      return r ? { key, source, id, audience: r.audience, purpose: r.purpose, label: r.purposeLabel, name: r.name, channel: r.channel, subject: r.subject || '', body: r.body, language: r.language, active: r.active, version: r.version } : null;
    }
    if (source === 'outreach' && (await S.ready())) {
      const r = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0];
      const ch = r ? ({ email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' })[r.channel] || r.channel : null;
      return r ? { key, source, id, audience: r.audience === 'internal' ? 'internal' : 'candidate_lead', purpose: '', label: '', name: r.name, channel: ch, subject: r.subject || '', body: r.body || '', language: '', active: r.status === 'active', version: null } : null;
    }
    if (source === 'job') {
      const row = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } });
      const t = (parse(row && row.value, []) || []).find((x) => x.id === id);
      return t ? { key, source, id, audience: 'job', purpose: '', label: 'Requirement description', name: t.name, channel: 'Job', subject: (t.fields && t.fields.title) || '', body: (t.fields && (t.fields.jobDescription || t.fields.description)) || '', language: '', active: true, version: null } : null;
    }
    if (source === 'post') {
      const row = await prisma.appSetting.findUnique({ where: { key: `jobtpl.lib.${id}` } });
      const t = parse(row && row.value, null);
      return t ? { key, source, id, audience: 'job', purpose: '', label: 'Job posting', name: t.name, channel: 'Posting', subject: (t.texts && t.texts.emailSubject) || '', body: (t.texts && (t.texts.whatsapp || t.texts.jobPost)) || '', language: '', active: true, version: null } : null;
    }
  } catch { /* an unreadable store = not found */ }
  return null;
}

// which apps may use it when nobody has said otherwise
function defaultScopes(r) {
  if (r.source === 'message') {
    if (r.audience === 'employee') return ['HRMS'];
    if (r.audience === 'client') return BILLING.includes(r.purpose) ? ['Accounts'] : ['ATS'];
    const s = ['ATS'];
    if (PORTAL_PURPOSES.includes(r.purpose) || /^CUSTOM_JOB_POST_/.test(r.purpose || '') || /^Job post:/i.test(r.label || '')) s.push('Job Portal');
    return s;
  }
  if (r.source === 'outreach') return r.audience === 'internal' ? ['Omni-Channel', 'HRMS'] : ['Omni-Channel', 'ATS', 'Job Portal'];
  return ['Job Portal'];
}

// ---- the library details (meta) ------------------------------------------------------------
async function metaMap() {
  await Schema.ensure();
  const rows = await S.q('SELECT * FROM "OmniTemplateMeta"');
  const m = new Map();
  rows.forEach((r) => m.set(r.templateKey, r));
  return m;
}
async function metaOf(key) {
  await Schema.ensure();
  return (await S.q('SELECT * FROM "OmniTemplateMeta" WHERE templateKey = ?', key))[0] || null;
}
async function deptOverlay() { return (await S.getKey('omni.templateDepts', {})) || {}; }
function scopesOf(r, meta) {
  const own = parse(meta && meta.scopes, null);
  const ok = Array.isArray(own) ? own.filter((a) => APPS.includes(a)) : [];
  return ok.length ? { list: ok, custom: true } : { list: defaultScopes(r), custom: false };
}
const approvalOf = (meta) => (meta && APPROVAL[meta.approval] ? meta.approval : 'approved');

// ---- who may do what ---------------------------------------------------------------------
// may this login SEE a template of this kind of audience? (the real contact rules)
async function seeRule(user) {
  const out = {};
  for (const [k, aud] of [['candidate', 'candidates'], ['client', 'clients'], ['employee', 'employees']]) out[k] = await access.ruleFor(user, aud).catch(() => ({ allowed: false })); // eslint-disable-line no-await-in-loop
  return out;
}
function visibleBy(user, r, rules) {
  if (isAdmin(user)) return true;
  if (r.source === 'message') {
    const rule = rules[r.audience];
    if (!rule || !rule.allowed) return false;
    return !rule.purposes || rule.purposes.includes(r.purpose);
  }
  if (r.source === 'outreach') return r.audience === 'internal' ? A.seesInternal(user) : A.seesLeads(user);
  return A.seesLeads(user);
}
// may this login use it IN this app (the app's own people)
function appOpen(user, app, rules) {
  if (isAdmin(user)) return true;
  if (app === 'Omni-Channel') return A.mayUse(user);
  if (app === 'HRMS') return !!(rules.employee && rules.employee.allowed);
  if (app === 'Accounts') return !!(rules.client && rules.client.allowed);
  if (app === 'Job Portal') return A.seesLeads(user) || !!(rules.candidate && rules.candidate.allowed);
  return !!((rules.candidate && rules.candidate.allowed) || (rules.client && rules.client.allowed) || A.seesLeads(user)); // ATS
}
function mayApprove(user, scopes, department) {
  if (isAdmin(user)) return true;
  if (department && !A.mayDepartment(user, department)) return false;
  if (scopes.every((s) => s === 'HRMS')) return A.kind(user) === 'hr';
  if (scopes.every((s) => s === 'Accounts')) return false; // an Admin approves Accounts wording
  return A.has('mayApprove')(user);
}
async function mayEditRaw(user, r) {
  if (r.source === 'message') return MT.canEdit(user);
  if (r.source === 'outreach') return require('../templates').canEdit(user, r.audience); // eslint-disable-line global-require
  return A.mayRun(user) || isAdmin(user);
}

// ---- the list -------------------------------------------------------------------------------
function shapeItem(user, base, r, meta, ov, rules, st, app) {
  const sc = scopesOf(r, meta);
  const ap = approvalOf(meta);
  const dept = (ov[base.key] || base.department || '').trim();
  const deptOk = isAdmin(user) || !dept || A.mayDepartment(user, dept);
  const approver = mayApprove(user, sc.list, dept);
  const out = {
    key: base.key, source: r.source, sourceWord: base.sourceWord || '', name: base.name, group: base.group || r.label || '', purpose: r.purpose || '', channel: base.channel, language: base.language || r.language || '', audience: r.audience,
    subject: base.subject || '', body: base.body || '', variables: varsIn(base.subject, base.body), department: dept,
    scopes: sc.list, scopesCustom: sc.custom,
    approval: { state: ap, words: APPROVAL[ap], note: (meta && meta.approvalNote) || '', by: (meta && (meta.decidedByName || meta.requestedByName)) || '', at: meta && (meta.decidedAt || meta.requestedAt) ? S.iso(meta.decidedAt || meta.requestedAt) : null },
    provider: base.wa ? { status: base.wa.status, name: base.wa.name || '' } : null,
    version: base.version || r.version || 1,
    updatedAt: base.updatedAt || null, byName: base.byName || '',
    canEdit: !!base.canEdit && deptOk, readOnlyWhy: base.canEdit ? '' : (base.readOnlyWhy || 'You can use this template, but you cannot change it.'),
    canApprove: approver && ap === 'waiting', canAsk: ap !== 'waiting' && !!base.canEdit,
    canChangeScopes: !!base.canEdit && deptOk, canUseHere: undefined,
    editPath: r.source === 'message' ? (['SUPER_ADMIN', 'ADMIN', 'HR'].some((x) => [user.role, user.atsRole].includes(x)) ? '/admin/message-templates' : '/omni-channel/templates') : '/omni-channel/templates',
  };
  const open = deptOk && visibleBy(user, r, rules);
  out.canUse = {};
  APPS.forEach((a) => { out.canUse[a] = open && sc.list.includes(a) && ap === 'approved' && appOpen(user, a, rules); });
  if (app) out.canUseHere = out.canUse[app] === true;
  out.whyNot = !app || out.canUseHere ? '' : (!sc.list.includes(app) ? `This template is not shared with ${APP_WORDS[app]}. Its owner can add ${APP_WORDS[app]} in "Used in".` : (ap !== 'approved' ? `It is ${APPROVAL[ap].toLowerCase()}, so it cannot be used yet.` : 'Your login cannot use it here.'));
  out.requiresApproval = st.requireApproval;
  return out;
}

// the message templates this login may see (uses the real contact rules), shaped like hub items
async function messageBase(user, rules) {
  if (!MT.supported()) return [];
  await MT.ensureDefaults().catch(() => {});
  // The emails vendors get (audience 'vendor') stay in Message templates > Vendors: they carry a one-time secure link, never a campaign.
  const rows = await prisma.messageTemplate.findMany({ where: { active: true, audience: { not: 'vendor' } }, orderBy: [{ purposeLabel: 'asc' }, { channel: 'asc' }] });
  const can = MT.canEdit(user);
  return rows.map((r) => ({
    r: { key: `message:${r.id}`, source: 'message', id: r.id, audience: r.audience, purpose: r.purpose, label: r.purposeLabel, language: r.language, version: r.version },
    base: {
      key: `message:${r.id}`, sourceWord: 'Message template', group: r.purposeLabel, name: r.name, channel: r.channel, language: r.language, subject: r.subject || '', body: r.body, version: r.version, department: '',
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null, byName: r.updatedByName || r.createdByName || '',
      wa: r.channel === 'WhatsApp' ? { status: r.waStatus || 'None', name: r.waTemplateName || '' } : null, canEdit: can, readOnlyWhy: can ? '' : 'Only an Admin, HR or a Team Lead can change message templates.',
    },
  })).filter((x) => visibleBy(user, x.r, rules));
}

async function list(user, { app = '', channel = '', q = '', approval = '', dept = '' } = {}) {
  await Schema.ensure();
  const rules = await seeRule(user);
  const st = await settings();
  const meta = await metaMap();
  const ov = await deptOverlay();
  const all = [];
  for (const x of await messageBase(user, rules)) all.push(shapeItem(user, x.base, x.r, meta.get(x.base.key), ov, rules, st, APPS.includes(app) ? app : '')); // eslint-disable-line no-await-in-loop
  if (A.mayUse(user)) {
    let hub = { items: [] };
    try { hub = await Hub.list(user, { where: 'all' }); } catch { hub = { items: [] }; }
    for (const i of hub.items) {
      if (!['outreach', 'job', 'post'].includes(i.source)) continue; // eslint-disable-line no-continue
      const r = { key: i.key, source: i.source, id: String(i.key).split(':')[1], audience: i.audience, purpose: '', label: i.group, language: i.language };
      all.push(shapeItem(user, i, r, meta.get(i.key), ov, rules, st, APPS.includes(app) ? app : ''));
    }
  }
  const needle = String(q || '').trim().toLowerCase();
  const deptNeedle = String(dept || '').trim().toLowerCase();
  const base = all.filter((i) => (!needle || `${i.name} ${i.group} ${i.subject} ${i.body}`.toLowerCase().includes(needle))
    && (!channel || String(i.channel).toLowerCase() === String(channel).toLowerCase())
    && (!approval || i.approval.state === approval)
    && (!deptNeedle || i.department.toLowerCase() === deptNeedle));
  const counts = { all: base.length };
  APPS.forEach((a) => { counts[a] = base.filter((i) => i.scopes.includes(a)).length; });
  const items = APPS.includes(app) ? base.filter((i) => i.scopes.includes(app)) : base;
  const channels = {};
  items.forEach((i) => { channels[i.channel] = (channels[i.channel] || 0) + 1; });
  const waiting = all.filter((i) => i.approval.state === 'waiting' && (isAdmin(user) || i.canApprove)).length;
  return { items: items.slice(0, 600), total: items.length, counts, channels, waiting, apps: APPS, approvalLabels: APPROVAL, settings: st, truncated: items.length > 600 };
}

async function one(user, key, app = '') {
  const [source] = splitKey(key);
  if (!['message', 'outreach', 'job', 'post'].includes(source)) return null;
  const r = await raw(key);
  if (!r || r.active === false) return null;
  const rules = await seeRule(user);
  if (!visibleBy(user, r, rules)) return null;
  const meta = await metaOf(key);
  const ov = await deptOverlay();
  const dept = (ov[key] || '').trim();
  if (!isAdmin(user) && dept && !A.mayDepartment(user, dept)) return null;
  const can = await mayEditRaw(user, r);
  const base = { key, sourceWord: source, group: r.label, name: r.name, channel: r.channel, language: r.language, subject: r.subject, body: r.body, version: r.version, department: dept, canEdit: can, readOnlyWhy: can ? '' : 'You can use this template, but you cannot change it.', updatedAt: null, byName: '' };
  return shapeItem(user, base, r, meta, ov, rules, await settings(), APPS.includes(app) ? app : '');
}

// ---- versions -----------------------------------------------------------------------------
async function versions(user, key) {
  const item = await one(user, key);
  if (!item) return { error: 'This template was not found.', status: 404 };
  const [source, id] = splitKey(key);
  let rows = [];
  if (source === 'message') {
    const t = await MT.get(id);
    rows = ((t && t.versions) || []).map((v) => ({ version: v.version, name: item.name, subject: v.subject, body: v.body, note: v.changeNote || '', byName: v.changedByName || '', at: v.createdAt ? new Date(v.createdAt).toISOString() : null, current: v.version === (t.version) }));
  } else {
    const got = await S.q('SELECT * FROM "OmniTemplateVersion" WHERE templateKey = ? ORDER BY version DESC', key);
    rows = got.map((v, i) => ({ version: S.num(v.version), name: v.name, subject: v.subject || '', body: v.body || '', note: v.changeNote || '', byName: v.byName || '', at: S.iso(v.at), current: i === 0 }));
    if (!rows.length) rows = [{ version: 1, name: item.name, subject: item.subject, body: item.body, note: 'The words as they are now (no earlier save was recorded).', byName: item.byName, at: item.updatedAt, current: true }];
  }
  return { key, name: item.name, versions: rows };
}
// keep the words of a template after a save (the owner stores without a history of their own). Never throws.
async function snapshot(user, key, note = '') {
  try {
    const [source] = splitKey(key);
    if (source === 'message') return null; // Message templates keep their own versions
    const r = await raw(key);
    if (!r) return null;
    await Schema.ensure();
    const last = (await S.q('SELECT * FROM "OmniTemplateVersion" WHERE templateKey = ? ORDER BY version DESC LIMIT 1', key))[0];
    if (last && last.body === r.body && (last.subject || '') === (r.subject || '') && last.name === r.name) return null;
    const n = last ? S.num(last.version) + 1 : 1;
    const meta = await metaOf(key);
    await S.run('INSERT OR IGNORE INTO "OmniTemplateVersion" (id, templateKey, version, name, channel, subject, body, scopes, department, approval, changeNote, byId, byName, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      S.newId('otv'), key, n, r.name, r.channel, r.subject, r.body, meta ? meta.scopes : null, meta ? meta.department : null, approvalOf(meta), clip(note, 300) || (n === 1 ? 'First saved version.' : 'Changed.'), user ? user.id : null, user ? user.name : null, Date.now());
    return n;
  } catch (e) { console.error('[omni-library] snapshot:', e.message); return null; } // eslint-disable-line no-console
}
// after a template was made or changed through the hub: keep the words, and (switch ON) send it for approval when the saver cannot approve it
async function afterSave(user, key, created) {
  try {
    const n = await snapshot(user, key, created ? 'Created.' : 'Changed.');
    const st = await settings();
    if (st.requireApproval && user && !isAdmin(user)) {
      const r = await raw(key);
      if (r && r.source !== 'message') {
        const sc = scopesOf(r, await metaOf(key)).list;
        if (!mayApprove(user, sc, '')) await setApproval(user, key, 'waiting', created ? 'New template: waiting for approval.' : 'Changed: waiting for approval.', { silent: true });
      }
    }
    return n;
  } catch (e) { console.error('[omni-library] afterSave:', e.message); return null; } // eslint-disable-line no-console
}

// ---- change the library details ------------------------------------------------------------------
async function upsertMeta(user, key, patch) {
  await Schema.ensure();
  const cur = await metaOf(key);
  const next = { ...(cur || { templateKey: key, approval: 'approved' }), ...patch };
  await S.run('INSERT INTO "OmniTemplateMeta" (templateKey, scopes, department, approval, approvalNote, requestedById, requestedByName, requestedAt, decidedById, decidedByName, decidedAt, updatedAt, updatedByName) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) '
    + 'ON CONFLICT(templateKey) DO UPDATE SET scopes=excluded.scopes, department=excluded.department, approval=excluded.approval, approvalNote=excluded.approvalNote, requestedById=excluded.requestedById, requestedByName=excluded.requestedByName, requestedAt=excluded.requestedAt, decidedById=excluded.decidedById, decidedByName=excluded.decidedByName, decidedAt=excluded.decidedAt, updatedAt=excluded.updatedAt, updatedByName=excluded.updatedByName',
  key, next.scopes || null, next.department || null, next.approval || 'approved', next.approvalNote || null, next.requestedById || null, next.requestedByName || null, S.ms(next.requestedAt) || null, next.decidedById || null, next.decidedByName || null, S.ms(next.decidedAt) || null, Date.now(), user ? user.name : null);
}
async function setScopes(user, key, scopes) {
  const item = await one(user, key);
  if (!item) return { error: 'This template was not found.', status: 404 };
  if (!item.canChangeScopes) return { error: 'Only the people who may edit this template can choose where it is used.', status: 403 };
  const list = [...new Set((Array.isArray(scopes) ? scopes : []).map(String))].filter((a) => APPS.includes(a));
  if (!list.length) return { error: 'Pick at least one place where this template is used.', status: 400 };
  // a template written for staff (HRMS) or for clients' payments (Accounts) cannot be pushed into a recruitment app
  if (item.source === 'message') {
    const forbidden = item.audience === 'employee' ? list.filter((a) => !['HRMS', 'Omni-Channel'].includes(a)) : (item.audience === 'candidate' ? list.filter((a) => ['HRMS', 'Accounts'].includes(a)) : list.filter((a) => ['HRMS', 'Job Portal'].includes(a)));
    if (forbidden.length) return { error: `This message is for ${item.audience === 'employee' ? 'employees' : (item.audience === 'candidate' ? 'candidates' : 'client contacts')}, so it cannot be shared with ${forbidden.join(' or ')}.`, status: 400 };
  }
  const was = item.scopes.join(', ');
  await upsertMeta(user, key, { scopes: JSON.stringify(list) });
  await snapshot(user, key, `Used in: ${list.join(', ')}.`);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Template library: where a template is used changed', entity: 'OmniTemplate', entityId: key, fromValue: was, toValue: list.join(', ') });
  return { ok: 'Saved.', scopes: list };
}

// the department of a template (an Admin; stored as the hub's overlay so the owner stores stay untouched)
async function setDepartment(user, key, dept) {
  const item = await one(user, key);
  if (!item) return { error: 'This template was not found.', status: 404 };
  const out = await Hub.setDept(user, key, dept);
  if (out.error) return out;
  await snapshot(user, key, `Department: ${clip(dept, 60) || 'everyone'}.`);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Template library: department of a template changed', entity: 'OmniTemplate', entityId: key, fromValue: item.department || '', toValue: clip(dept, 60) });
  return { ok: 'Saved.' };
}

async function setApproval(user, key, state, note, { silent = false } = {}) {
  await upsertMeta(user, key, state === 'waiting'
    ? { approval: 'waiting', approvalNote: clip(note, 300), requestedById: user.id, requestedByName: user.name, requestedAt: Date.now(), decidedById: null, decidedByName: null, decidedAt: null }
    : { approval: state, approvalNote: clip(note, 300), decidedById: user.id, decidedByName: user.name, decidedAt: Date.now() });
  if (!silent || state === 'waiting') {
    await logAudit({ userId: user.id, actorName: user.name, action: state === 'waiting' ? 'Template library: approval asked' : (state === 'approved' ? 'Template library: template approved' : 'Template library: template sent back'), entity: 'OmniTemplate', entityId: key, toValue: clip(note, 200) || APPROVAL[state] });
  }
}
async function approvalAction(user, key, action, note) {
  const item = await one(user, key);
  if (!item) return { error: 'This template was not found.', status: 404 };
  if (action === 'ask') {
    if (!item.canAsk) return { error: item.approval.state === 'waiting' ? 'It is already waiting for approval.' : 'Only the people who may edit this template can ask for approval.', status: item.approval.state === 'waiting' ? 409 : 403 };
    await setApproval(user, key, 'waiting', note);
    const ids = await approverIds(item);
    if (ids.length) { try { await require('../../utils/notify').notifyUsers(ids.filter((x) => x !== user.id), { title: `Template "${clip(item.name, 60)}" needs your approval`, message: `${clip(user.name, 60)} asked for approval. Open the Template library.` }); } catch { /* the bell is a courtesy */ } } // eslint-disable-line global-require
    return { ok: 'Sent for approval.', approval: 'waiting' };
  }
  if (!['approve', 'send_back'].includes(action)) return { error: 'Unknown action.', status: 400 };
  if (item.approval.state !== 'waiting') return { error: 'This template is not waiting for approval.', status: 409 };
  if (!mayApprove(user, item.scopes, item.department)) return { error: 'Only an approver for this template can decide.', status: 403 };
  if (action === 'send_back' && clip(note, 300).length < 5) return { error: 'Write a few words so the person knows what to change.', status: 400 };
  const meta = await metaOf(key);
  if (action === 'approve' && meta && meta.requestedById === user.id && !isAdmin(user)) return { error: 'You asked for this approval yourself. Somebody else has to approve it.', status: 403 };
  await setApproval(user, key, action === 'approve' ? 'approved' : 'changes', note);
  if (meta && meta.requestedById && meta.requestedById !== user.id) {
    try { await require('../../utils/notify').notifyUsers([meta.requestedById], action === 'approve' ? { title: `Template "${clip(item.name, 60)}" was approved`, message: 'You can use it now.' } : { title: `Template "${clip(item.name, 60)}" needs changes`, message: clip(note, 200) }); } catch { /* courtesy */ } // eslint-disable-line global-require
  }
  return { ok: action === 'approve' ? 'Approved. It can be used now.' : 'Sent back with your note.', approval: action === 'approve' ? 'approved' : 'changes' };
}
async function approverIds(item) {
  const out = [];
  try {
    const { resolveIdentity } = require('../../utils/identity'); // eslint-disable-line global-require
    const users = await prisma.user.findMany({ where: { status: 'Active' }, select: { id: true, name: true, email: true, role: true, atsRole: true } });
    const maybe = users.filter((u) => ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL', 'HR'].some((r) => [u.role, u.atsRole].includes(r)) && !/zztest|example\.test/i.test(`${u.name} ${u.email}`));
    for (const u of maybe.slice(0, 80)) {
      let ident = null; try { ident = await resolveIdentity(u.id); } catch { ident = null; } // eslint-disable-line no-await-in-loop
      if (ident && mayApprove(ident, item.scopes, item.department)) out.push(u.id);
    }
  } catch { /* courtesy */ }
  return out;
}

// ---- the gate the campaign code calls ---------------------------------------------------------------
// null = fine; else { error, status, code }
async function gate(user, key, app) {
  const item = await one(user, key, app);
  if (!item) return { error: 'This template was not found, or it is not available to you.', status: 404, code: 'tpl_hidden' };
  if (!item.scopes.includes(app)) return { error: item.whyNot, status: 403, code: 'tpl_scope' };
  if (item.approval.state !== 'approved') return { error: `This template is ${item.approval.words.toLowerCase()}. Pick an approved one.`, status: 400, code: 'tpl_not_approved' };
  if (!item.canUse[app]) return { error: item.whyNot || 'Your login cannot use this template here.', status: 403, code: 'tpl_denied' };
  return null;
}
// same check for a template given by its store row id (the job campaign engine knows the OutreachTemplate id)
const gateOutreach = (user, id, app = 'Omni-Channel') => gate(user, `outreach:${id}`, app);

module.exports = { setDepartment, APPS, APPROVAL, BILLING, list, one, versions, snapshot, afterSave, setScopes, approvalAction, gate, gateOutreach, settings, saveSettings, defaultScopes, scopesOf, raw, splitKey, mayApprove, visibleBy, seeRule, appOpen, varsIn, metaOf, upsertMeta };
