// ---------------------------------------------------------------------------
// OMNI-CHANNEL TEMPLATE HUB (founder note (d), 2026-10-17): ONE list of every template, read from the stores that own them. Nothing is copied.
//   message   MessageTemplate        (utils/messageTemplates.js; Administration > Message templates)   used in ATS / HRMS (by audience); "Job post:" ones also Job Portal
//   outreach  OutreachTemplate       (outreach/templates.js; campaign messages)                          used in Omni-Channel (internal ones: HRMS / internal)
//   job       AppSetting 'job-templates'  (a saved job: title, description ...)                           used in Job Portal
//   post      AppSetting 'jobtpl.lib.*'   (My job templates: WhatsApp / SMS / email / job-post texts)       used in Job Portal
// Who sees what follows access.js: Admin all; HR / Internal HR only the staff-side ones (employee message templates, internal campaign messages);
// Recruiter / TL / BDE ... the candidate-side ones, and saved jobs of their own department (or ones they saved). Edit goes through the OWNING
// store's own rules (the old screens and this one can never disagree).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const S = require('./store');
const OT = require('./templates');
const MT = require('../utils/messageTemplates');
const { logAudit } = require('../utils/audit');

const WHERE = ['ATS', 'Omni-Channel', 'Job Portal', 'HRMS / internal'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const isAdminRole = (u) => ADMIN_ROLES.includes(u.role) || ADMIN_ROLES.includes(u.atsRole);
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const iso = (v) => { const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v)); return t ? new Date(t).toISOString() : null; };

function staffOnly(u) { return A.kind(u) === 'hr'; } // HR sees the internal side only

async function messageItems(u) {
  if (!MT.supported() || !A.mayUse(u)) return []; // looking is open to everyone who uses Omni-Channel (editing is not)
  await MT.ensureDefaults().catch(() => {}); // the same built-in wording the Message templates screen seeds first (so the hub and the old screen always count the same)
  const rows = await prisma.messageTemplate.findMany({ where: { active: true }, orderBy: [{ purposeLabel: 'asc' }, { channel: 'asc' }] });
  const canEdit = MT.canEdit(u);
  const out = [];
  for (const r of rows) {
    const employee = r.audience === 'employee';
    const where = [];
    if (employee) where.push('HRMS / internal'); else where.push('ATS');
    if (/^CUSTOM_JOB_POST_/.test(r.purpose) || /^Job post:/i.test(r.purposeLabel || '')) where.push('Job Portal');
    if (staffOnly(u) && !employee) continue; // eslint-disable-line no-continue
    if (!A.isAdmin(u) && A.kind(u) !== 'hr' && employee) continue; // eslint-disable-line no-continue
    out.push({
      key: `message:${r.id}`, source: 'message', sourceWord: 'Message template', where, name: r.name, group: r.purposeLabel, channel: r.channel, language: r.language, audience: r.audience,
      subject: r.subject || '', body: r.body, department: '', updatedAt: iso(r.updatedAt), byName: r.updatedByName || r.createdByName || '',
      wa: r.channel === 'WhatsApp' ? { status: r.waStatus || 'None', name: r.waTemplateName || '' } : null, canEdit, readOnlyWhy: canEdit ? '' : 'Only an Admin, HR or a Team Lead can change message templates.',
      oldPlace: 'Administration > Company Setup > Message templates',
    });
  }
  return out;
}
async function outreachItems(u) {
  if (!(await S.ready())) return [];
  const out = [];
  for (const type of ['candidate_lead', 'internal']) {
    let list = [];
    try { list = await OT.list(u, { type: type === 'internal' ? 'internal' : 'lead' }); } catch { list = []; }
    list.forEach((r) => {
      const can = type === 'internal' ? A.mayRunInternal(u) : ['admin', 'bdetl', 'bde', 'tl', 'marketing'].includes(A.kind(u));
      out.push({
        key: `outreach:${r.id}`, source: 'outreach', sourceWord: 'Campaign message', where: type === 'internal' ? ['Omni-Channel', 'HRMS / internal'] : ['Omni-Channel'], name: r.name, group: type === 'internal' ? 'Staff campaign' : 'Job campaign',
        channel: ({ email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' })[r.channel] || r.channel, language: '', audience: type, subject: r.subject || '', body: r.body || '', department: '',
        updatedAt: iso(r.updatedAt), byName: r.createdByName || '', wa: r.channel === 'whatsapp' ? { status: ({ draft: 'None', pending: 'Pending', approved: 'Approved', rejected: 'Rejected' })[r.waApprovalStatus] || 'None', name: r.waTemplateName || '' } : null, // same words as message templates, so the approval queue counts both
        canEdit: can, readOnlyWhy: can ? '' : 'Only the BDE team, Team Leads and Admins write requirement campaign messages.', oldPlace: 'Omni-Channel > Templates',
        // v3 (Templates page): what the rich form needs, read straight from OutreachTemplate (nothing is copied)
        id: r.id, category: r.category, extra: r.extra, promotional: r.promotional, waLanguage: r.waLanguage || '', dltTemplateId: r.dltTemplateId || '', senderId: r.senderId || '', ready: r.ready, readyWhy: r.why || '', waMap: r.waMap || null,
      });
    });
  }
  return out;
}
async function jobItems(u) {
  if (!A.seesLeads(u)) return [];
  const row = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } }).catch(() => null);
  const list = row ? parse(row.value, []) : [];
  return (Array.isArray(list) ? list : []).filter((t) => {
    const d = t.fields && t.fields.department;
    return A.isAdmin(u) || t.createdById === u.id || A.mayDepartment(u, d);
  }).map((t) => {
    const can = isAdminRole(u) || t.createdById === u.id;
    return {
      key: `job:${t.id}`, source: 'job', sourceWord: 'Saved requirement', where: ['Job Portal'], name: t.name, group: 'Requirement description', channel: 'Job', language: '', audience: 'job',
      subject: (t.fields && t.fields.title) || '', body: (t.fields && (t.fields.jobDescription || t.fields.description)) || '', department: (t.fields && t.fields.department) || '',
      updatedAt: iso(t.updatedAt || t.createdAt), byName: t.updatedByName || t.createdByName || '', wa: null, canEdit: can, readOnlyWhy: can ? '' : `Only ${t.createdByName || 'the person who saved it'} or an Admin can change it.`, oldPlace: 'Jobs > New job > My job templates',
    };
  });
}
async function postItems(u) {
  if (!A.seesLeads(u)) return [];
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'jobtpl.lib.' } } }).catch(() => []);
  return rows.map((r) => ({ id: r.key, t: parse(r.value, null) })).filter((x) => x.t && x.t.id).map(({ t }) => {
    const can = A.mayRun(u) && (t.byId === u.id || A.isAdmin(u));
    const tx = t.texts || {};
    return {
      key: `post:${t.id}`, source: 'post', sourceWord: 'Job posting text', where: ['Job Portal'], name: t.name, group: t.jobTitle || 'Job posting', channel: 'Posting', language: '', audience: 'job',
      subject: tx.emailSubject || '', body: tx.whatsapp || tx.jobPost || '', department: '', updatedAt: iso(t.editedAt || t.at), byName: t.editedByName || t.byName || '', wa: null,
      canEdit: can, readOnlyWhy: can ? '' : 'Only the person who saved it, or an Admin, can change it.', oldPlace: 'Requirements > My requirement templates',
    };
  });
}

// call scripts: built-in wording for the Call window (read only here; AI call scripts are planned, not built)
function scriptItems(u) {
  if (!A.mayUse(u) || A.kind(u) === 'hr') return [];
  return require('../utils/messageScripts').SCRIPTS.map((x) => ({ // eslint-disable-line global-require
    key: 'script:' + x.purpose, source: 'script', sourceWord: 'Call script', where: ['ATS'], name: x.label, group: 'What to say on the phone', channel: 'Call script', language: '', audience: x.audience, subject: '', body: x.body, department: '', updatedAt: null, byName: 'Built in', wa: null,
    canEdit: false, readOnlyWhy: 'Call scripts are built in and are only read here.', oldPlace: 'the Call window',
  }));
}
// which department a template belongs to (an Admin sets it in the hub; stored as an overlay so the owner stores stay untouched)
async function deptOverlay() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'omni.templateDepts' } }).catch(() => null);
  return row ? parse(row.value, {}) : {};
}
async function setDept(u, key, dept) {
  if (!A.isAdmin(u)) return { error: 'Only an Admin can give a template to a department.', status: 403 };
  const map = await deptOverlay();
  const d = String(dept || '').trim().slice(0, 60);
  if (d) map[key] = d; else delete map[key];
  const v = JSON.stringify(map);
  await prisma.appSetting.upsert({ where: { key: 'omni.templateDepts' }, create: { key: 'omni.templateDepts', value: v, updatedById: u.id, updatedByName: u.name }, update: { value: v, updatedById: u.id, updatedByName: u.name } });
  return { ok: 'Saved.' };
}

async function list(u, { where = '', q = '', channel = '', approval = '' } = {}) {
  if (!A.mayUse(u)) return { items: [], counts: {}, kinds: {} };
  const ov = await deptOverlay();
  const all = [...await messageItems(u), ...await outreachItems(u), ...await jobItems(u), ...await postItems(u), ...scriptItems(u)]
    .map((i) => ({ ...i, department: ov[i.key] || i.department }))
    .filter((i) => A.isAdmin(u) || !i.department || A.mayDepartment(u, i.department));
  const needle = String(q || '').trim().toLowerCase();
  const matchQ = (i) => !needle || `${i.name} ${i.group} ${i.subject} ${i.body}`.toLowerCase().includes(needle);
  const matchCh = (i) => !channel || i.channel === channel;
  const waState = (i) => (i.wa ? i.wa.status : null);
  const queue = { pending: all.filter((i) => waState(i) === 'Pending').length, notSent: all.filter((i) => waState(i) === 'None').length, rejected: all.filter((i) => waState(i) === 'Rejected').length };
  const matchAp = (i) => !approval || (approval === 'queue' ? ['Pending', 'None'].includes(waState(i)) : (approval === 'pending' ? waState(i) === 'Pending' : (approval === 'rejected' ? waState(i) === 'Rejected' : waState(i) === 'None')));
  const base = all.filter((i) => matchQ(i) && matchCh(i) && matchAp(i));
  const counts = { all: base.length };
  WHERE.forEach((w) => { counts[w] = base.filter((i) => i.where.includes(w)).length; });
  const items = base.filter((i) => !where || where === 'all' || i.where.includes(where));
  const channels = {};
  all.filter((i) => matchQ(i) && (!where || where === 'all' || i.where.includes(where))).forEach((i) => { channels[i.channel] = (channels[i.channel] || 0) + 1; });
  return { items: items.slice(0, 600), total: items.length, counts, channels, queue, truncated: items.length > 600 };
}

// ---- edit / create: always through the owner's own rules ---------------------------------------------------
async function update(u, key, b) {
  const [source, id] = String(key || '').split(/:(.*)/s);
  if (b.department !== undefined && A.isAdmin(u)) { const d = await setDept(u, key, b.department); if (d.error) return d; if (Object.keys(b).every((k) => k === 'department')) return d; }
  if (source === 'message') {
    if (!MT.canEdit(u)) return { error: 'Only an Admin, HR or a Team Lead can change message templates.', status: 403 };
    const input = {}; ['name', 'subject', 'body', 'active', 'waTemplateName', 'waLanguageCode', 'waStatus', 'dltTemplateId', 'senderId'].forEach((k) => { if (b[k] !== undefined) input[k] = b[k]; });
    const out = await MT.update(u, id, input);
    return out.error ? out : { ok: 'Saved.' };
  }
  if (source === 'outreach') {
    // v3: category, promotional, WhatsApp language and the rich layout (extra) go through the same owner rules
    const out = await OT.update(u, id, { name: b.name, subject: b.subject, body: b.body, waTemplateName: b.waTemplateName, waApprovalStatus: b.waApprovalStatus, dltTemplateId: b.dltTemplateId, senderId: b.senderId, category: b.category, extra: b.extra, promotional: b.promotional, waLanguage: b.waLanguage });
    return out.error ? out : { ok: 'Saved.' };
  }
  if (source === 'job') {
    const row = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } });
    const list = row ? parse(row.value, []) : [];
    const t = list.find((x) => x.id === id);
    if (!t) return { error: 'That template is gone already.', status: 404 };
    if (!(isAdminRole(u) || t.createdById === u.id)) return { error: `Only ${t.createdByName || 'the person who saved it'} or an Admin can change this template.`, status: 403 };
    const next = { ...t, fields: { ...(t.fields || {}) } };
    if (b.name !== undefined) {
      const name = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (name.length < 2) return { error: 'Give the template a name.', status: 400 };
      if (list.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) return { error: `There is already a template called "${name}".`, status: 409 };
      next.name = name;
    }
    if (b.subject !== undefined) { if (!String(b.subject).trim()) return { error: 'Fill in the requirement title.', status: 400 }; next.fields.title = String(b.subject).slice(0, 160); }
    if (b.body !== undefined) next.fields.jobDescription = String(b.body).slice(0, 20000);
    next.updatedAt = new Date().toISOString(); next.updatedByName = u.name;
    const v = JSON.stringify(list.map((x) => (x.id === t.id ? next : x)));
    await prisma.appSetting.update({ where: { key: 'job-templates' }, data: { value: v, updatedById: u.id, updatedByName: u.name } });
    await logAudit({ userId: u.id, action: 'Requirement template changed', entity: 'JobTemplate', entityId: t.id, fromValue: t.name, toValue: next.name });
    return { ok: 'Saved.' };
  }
  if (source === 'post') {
    const rowKey = `jobtpl.lib.${id}`;
    const row = await prisma.appSetting.findUnique({ where: { key: rowKey } });
    const t = row ? parse(row.value, null) : null;
    if (!t) return { error: 'That template was not found.', status: 404 };
    if (!A.mayRun(u) || !(t.byId === u.id || A.isAdmin(u))) return { error: 'Only the person who saved it, or an Admin, can change it.', status: 403 };
    const next = { ...t, texts: { ...(t.texts || {}) } };
    if (b.name !== undefined) { const name = String(b.name).trim().slice(0, 80); if (name.length < 2) return { error: 'Give the template a name.', status: 400 }; next.name = name; }
    if (b.subject !== undefined) next.texts.emailSubject = String(b.subject).slice(0, 4000);
    if (b.body !== undefined) { if (!String(b.body).trim()) return { error: 'There is no text to save.', status: 400 }; next.texts.whatsapp = String(b.body).slice(0, 4000); }
    next.editedById = u.id; next.editedByName = u.name; next.editedAt = new Date().toISOString();
    await prisma.appSetting.update({ where: { key: rowKey }, data: { value: JSON.stringify(next), updatedById: u.id, updatedByName: u.name } });
    await logAudit({ userId: u.id, actorName: u.name, action: 'Job posting text changed (template hub)', entity: 'JobTemplate', entityId: t.id, toValue: next.name });
    return { ok: 'Saved.' };
  }
  return { error: 'Unknown template.', status: 404 };
}
async function create(u, b) {
  const kind = String(b.source || 'outreach');
  if (kind === 'message') {
    if (!MT.canEdit(u)) return { error: 'Only an Admin, HR or a Team Lead can add message templates.', status: 403 };
    const out = await MT.create(u, { purposeLabel: b.group || b.name, name: b.name, channel: b.channel, subject: b.subject, body: b.body, audience: b.audience === 'employee' ? 'employee' : 'candidate', language: b.language });
    return out.error ? out : { ok: 'Saved.' };
  }
  if (kind === 'outreach') {
    const out = await OT.create(u, { name: b.name, channel: String(b.channel || 'email').toLowerCase(), audience: b.audience === 'internal' ? 'internal' : 'candidate_lead', subject: b.subject, body: b.body, promotional: b.promotional !== undefined ? !!b.promotional : b.audience !== 'internal', category: b.category, extra: b.extra, waLanguage: b.waLanguage, dltTemplateId: b.dltTemplateId, senderId: b.senderId });
    return out.error ? out : { ok: 'Saved.', template: out.template };
  }
  return { error: 'Add requirement templates from the Requirements screen (New requirement > Save as template); they then show here.', status: 400 };
}

// Shared template library (outreach/omni/library.js): keep the words after every save (version history) and, when the library switch is on, send a change by somebody who
// cannot approve it for approval. Never throws; a failure here cannot break the save.
const Lib = () => require('./omni/library'); // eslint-disable-line global-require
async function createKept(u, b) {
  const out = await create(u, b);
  if (out && !out.error && out.template && out.template.id) await Lib().afterSave(u, `outreach:${out.template.id}`, true);
  return out;
}
async function updateKept(u, key, b) {
  const out = await update(u, key, b);
  if (out && !out.error && !/^message:/.test(String(key))) await Lib().afterSave(u, key, false);
  return out;
}

module.exports = { list, update: updateKept, create: createKept, setDept, WHERE };
