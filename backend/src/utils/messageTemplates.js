// ---------------------------------------------------------------------------
// MESSAGE TEMPLATES — one place for the wording of every Email / SMS /
// WhatsApp message the app sends.
//
//   resolve()      THE ONE RESOLVER every sender uses: template for
//                  purpose + channel + language -> English -> the built-in
//                  default that used to be hard-coded (messageDefaults.js).
//   render()       fills {{tokens}} (and the older {token}) from real values;
//                  reports which ones had no value (never invents one).
//   CRUD           every edit is a NEW VERSION; old versions are kept, with
//                  who changed what (MessageTemplateVersion).
//
// The built-in wording is seeded as version 1 the first time the list is
// opened (ensureDefaults) and is never overwritten afterwards, so nothing
// changes until a person edits a template. Before the tables exist the
// resolver simply answers with the built-in default.
//
// WhatsApp: a template's provider NAME and approval status are typed in by an
// Admin from the Meta console — this module never marks one Approved by itself.
// SMS: the DLT template id and sender id are typed in the same way.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { logAudit } = require('./audit');

// 'Call' is a call SCRIPT (talking points shown while phoning); it is never sent.
const CHANNELS = ['Email', 'SMS', 'WhatsApp', 'Call'];
const LANGUAGES = ['English', 'Telugu', 'Hindi'];
const WA_STATUSES = ['None', 'Pending', 'Approved', 'Rejected'];
const AUDIENCES = ['candidate', 'client', 'employee'];
const MAX_BODY = { Email: 4000, SMS: 1000, WhatsApp: 1024, Call: 2000 };

// --- tokens -----------------------------------------------------------------
// key, plain label, a sample for the live preview, aliases people may have typed.
const TOKENS = [
  { key: 'name', label: 'Person\'s name', sample: 'Anita Rao', group: 'Person', aliases: ['candidateName', 'contactName', 'employeeName', 'fullName'] },
  { key: 'firstName', label: 'First name', sample: 'Anita', group: 'Person', aliases: [] },
  { key: 'role', label: 'Job title', sample: 'Staff Nurse', group: 'Job', aliases: ['jobTitle', 'job'] },
  { key: 'client', label: 'Client name', sample: 'City Care Hospital', group: 'Job', aliases: ['clientName'] },
  { key: 'jobLink', label: 'Job link', sample: 'https://tmlink.in/careers/staff-nurse', group: 'Job', aliases: [] },
  { key: 'interviewAt', label: 'Interview date and time', sample: 'Mon, 12 Oct, 11:00 am', group: 'Interview', aliases: [] },
  { key: 'interviewDate', label: 'Interview date', sample: 'Mon, 12 Oct', group: 'Interview', aliases: [] },
  { key: 'interviewTime', label: 'Interview time', sample: '11:00 am', group: 'Interview', aliases: [] },
  { key: 'mode', label: 'Interview mode', sample: 'Online', group: 'Interview', aliases: [] },
  { key: 'interviewer', label: 'Interviewer', sample: 'Dr. Mehta', group: 'Interview', aliases: [] },
  { key: 'meetingLink', label: 'Interview link', sample: 'https://meet.example.com/abc', group: 'Interview', aliases: ['interviewLink'] },
  { key: 'venue', label: 'Interview place', sample: 'City Care Hospital, Hyderabad', group: 'Interview', aliases: ['location'] },
  { key: 'interviewRound', label: 'Interview round', sample: '1', group: 'Interview', aliases: [] },
  { key: 'interviewWhere', label: 'Where (link or address)', sample: 'Online - join here: https://meet.example.com/abc', group: 'Interview', aliases: [] },
  { key: 'interviewContact', label: 'Who to ask (recruiter)', sample: 'Ravi Kumar, 98765 43210', group: 'Interview', aliases: [] },
  { key: 'prepNote', label: 'How to prepare (link)', sample: 'How to prepare: https://tmlink.in/prep/abc', group: 'Interview', aliases: [] },
  { key: 'interviewOld', label: 'Old interview time', sample: 'Sat, 10 Oct, 10:00 am', group: 'Interview', aliases: [] },
  { key: 'deadline', label: 'AI interview deadline', sample: '14 Oct', group: 'Interview', aliases: [] },
  { key: 'offerCtc', label: 'Offer CTC', sample: '4.2 LPA', group: 'Offer', aliases: ['ctc'] },
  { key: 'joiningDate', label: 'Joining date', sample: '1 Nov 2026', group: 'Offer', aliases: [] },
  { key: 'agreementLink', label: 'Agreement link', sample: 'https://tmlink.in/agreement/xyz', group: 'Client', aliases: [] },
  { key: 'recruiterName', label: 'Your name (sender)', sample: 'Ravi Kumar', group: 'You', aliases: ['sender'] },
  { key: 'recruiterPhone', label: 'Your phone', sample: '+91 98765 43210', group: 'You', aliases: [] },
  { key: 'recruiterEmail', label: 'Your email', sample: 'ravi@tmlink.in', group: 'You', aliases: [] },
  { key: 'company', label: 'Our company', sample: 'TeamLink Consultants', group: 'You', aliases: [] },
  { key: 'today', label: 'Today\'s date', sample: '9 Oct 2026', group: 'You', aliases: [] },
];
const CANON = {};
TOKENS.forEach((t) => { CANON[t.key] = t.key; t.aliases.forEach((a) => { CANON[a] = t.key; }); });
const canonOf = (k) => CANON[k] || null;
const SAMPLE = Object.fromEntries(TOKENS.map((t) => [t.key, t.sample]));

// {{name}} (also {{ name }}) and the older single-brace {name}; {{1}} numbers are not tokens.
const TOKEN_RE = /\{\{\s*([A-Za-z_]\w*)\s*\}\}|\{([A-Za-z_]\w*)\}/g;

function tokensIn(text) {
  const out = [];
  String(text || '').replace(TOKEN_RE, (m, a, b) => {
    const k = a || b;
    const c = canonOf(k);
    if (c) { if (!out.includes(c)) out.push(c); } else if (a && !out.includes(`?${a}`)) out.push(`?${a}`);
    return m;
  });
  return out;
}
const unknownTokens = (text) => tokensIn(text).filter((t) => t.startsWith('?')).map((t) => t.slice(1));

function normValues(values) {
  const out = {};
  Object.entries(values || {}).forEach(([k, v]) => { const c = canonOf(k); if (c && (out[c] == null || out[c] === '')) out[c] = v; });
  return out;
}

// render(text, values, { blank }) -> { text, missing: [token keys with no value] }
// blank: if given, a missing value is replaced by it (the old automatic
// messages print an em dash); otherwise the {{placeholder}} stays visible.
function render(text, values, { blank } = {}) {
  const v = normValues(values);
  const missing = [];
  const out = String(text == null ? '' : text).replace(TOKEN_RE, (m, a, b) => {
    const c = canonOf(a || b);
    if (!c) return m;
    const val = v[c];
    if (val == null || String(val).trim() === '') {
      if (!missing.includes(c)) missing.push(c);
      return blank !== undefined ? blank : m;
    }
    return String(val);
  });
  return { text: out, missing };
}

// SMS length: GSM-7 160 (153 per part) or, for Telugu / Hindi / emoji, UCS-2 70 (67 per part).
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
function smsInfo(text) {
  const s = String(text || '');
  let len = 0;
  let gsm = true;
  for (const ch of s) {
    if (GSM.includes(ch)) len += 1; else if (GSM_EXT.includes(ch)) len += 2; else { gsm = false; break; }
  }
  if (!gsm) {
    const n = [...s].length;
    return { chars: n, encoding: 'Unicode (Telugu / Hindi / emoji)', perSegment: n <= 70 ? 70 : 67, segments: n === 0 ? 0 : (n <= 70 ? 1 : Math.ceil(n / 67)) };
  }
  return { chars: len, encoding: 'Plain', perSegment: len <= 160 ? 160 : 153, segments: len === 0 ? 0 : (len <= 160 ? 1 : Math.ceil(len / 153)) };
}

// --- who may do what ---------------------------------------------------------
const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole].filter(Boolean);
const EDIT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR', 'TL'];
const VIEW_ROLES = [...EDIT_ROLES, 'MANAGER', 'ASSISTANT_MANAGER', 'STL'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const external = (u) => rolesOf(u).some((r) => ['CLIENT', 'CANDIDATE'].includes(r));
const canEdit = (u) => !!u && !u.viewAs && !external(u) && rolesOf(u).some((r) => EDIT_ROLES.includes(r));
const canView = (u) => !!u && !external(u) && rolesOf(u).some((r) => VIEW_ROLES.includes(r));
const isAdmin = (u) => !!u && !u.viewAs && rolesOf(u).some((r) => ADMIN_ROLES.includes(r));

// --- storage -----------------------------------------------------------------
function supported() { return !!(prisma.messageTemplate && prisma.messageTemplateVersion); }

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    purpose: row.purpose,
    purposeLabel: row.purposeLabel,
    audience: row.audience,
    channel: row.channel,
    language: row.language,
    name: row.name,
    subject: row.subject || '',
    body: row.body,
    active: !!row.active,
    isDefault: !!row.isDefault,
    builtIn: !!row.builtIn,
    version: row.version,
    waTemplateName: row.waTemplateName || '',
    waLanguageCode: row.waLanguageCode || '',
    waStatus: row.waStatus || 'None',
    waVars: parseJson(row.waVars, []),
    dltTemplateId: row.dltTemplateId || '',
    senderId: row.senderId || '',
    updatedByName: row.updatedByName || row.createdByName || null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

// WhatsApp {{1}} {{2}} … -> token. The saved mapping, else the tokens of the
// body in the order they appear.
function waVarList(t) {
  const saved = Array.isArray(t.waVars) ? t.waVars.map(canonOf).filter(Boolean) : [];
  if (saved.length) return saved;
  return tokensIn(t.body).filter((k) => !k.startsWith('?'));
}

let seeded = null;
async function ensureDefaults() {
  if (!supported()) return { seeded: 0, supported: false };
  if (seeded) return seeded;
  seeded = (async () => {
    // eslint-disable-next-line global-require
    const defaults = require('./messageDefaults').list();
    const have = await prisma.messageTemplate.findMany({ where: { builtIn: true }, select: { purpose: true, channel: true, language: true } });
    const haveKey = new Set(have.map((r) => `${r.purpose}|${r.channel}|${r.language}`));
    let n = 0;
    for (const d of defaults) {
      if (haveKey.has(`${d.purpose}|${d.channel}|${d.language}`)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await prisma.messageTemplate.create({
        data: {
          purpose: d.purpose, purposeLabel: d.label, audience: d.audience, channel: d.channel, language: d.language,
          name: d.label, subject: d.channel === 'Email' ? d.subject : null, body: d.body, active: true, isDefault: true, builtIn: true, version: 1,
          createdByName: 'Built-in wording', updatedByName: 'Built-in wording',
          versions: { create: [{ version: 1, subject: d.channel === 'Email' ? d.subject : null, body: d.body, active: true, changeNote: 'Built-in wording (version 1)', changedByName: 'Built-in wording' }] },
        },
      });
      n += 1;
    }
    return { seeded: n, supported: true };
  })().catch((err) => { seeded = null; console.error('[message-templates] seed:', err.message); return { seeded: 0, error: err.message }; });
  return seeded;
}

// --- THE RESOLVER ------------------------------------------------------------
// -> { source: 'saved' | 'built-in', id, version, name, subject, body, active,
//      waTemplateName, waStatus, waLanguageCode, waVars, dltTemplateId, senderId,
//      language, purpose, channel } or null when nobody has wording for it.
async function resolve({ purpose, channel, language = 'English', templateId } = {}) {
  if (supported()) {
    try {
      await ensureDefaults();
      if (templateId) {
        const one = await prisma.messageTemplate.findUnique({ where: { id: templateId } });
        if (one && one.active) return { source: 'saved', ...shape(one) };
      }
      const rows = await prisma.messageTemplate.findMany({ where: { purpose, channel, active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
      const pick = rows.find((r) => r.language === language && r.isDefault) || rows.find((r) => r.language === language)
        || rows.find((r) => r.language === 'English' && r.isDefault) || rows.find((r) => r.language === 'English');
      if (pick) return { source: 'saved', ...shape(pick) };
    } catch (err) { console.error('[message-templates] resolve:', err.message); }
  }
  // eslint-disable-next-line global-require
  const d = require('./messageDefaults').find(purpose, channel);
  if (!d) return null;
  return {
    source: 'built-in', id: null, version: 1, name: d.label, purpose: d.purpose, purposeLabel: d.label, channel, language: 'English',
    subject: d.channel === 'Email' ? d.subject : '', body: d.body, active: true, waTemplateName: '', waStatus: 'None', waLanguageCode: '', waVars: [], dltTemplateId: '', senderId: '',
  };
}

// --- list / read -------------------------------------------------------------
async function list({ channel, purpose, language, audience, activeOnly, q } = {}) {
  if (!supported()) return [];
  await ensureDefaults();
  const where = {};
  if (CHANNELS.includes(channel)) where.channel = channel;
  if (purpose) where.purpose = purpose;
  if (LANGUAGES.includes(language)) where.language = language;
  if (AUDIENCES.includes(audience)) where.audience = audience;
  if (activeOnly) where.active = true;
  const rows = await prisma.messageTemplate.findMany({ where, orderBy: [{ purposeLabel: 'asc' }, { channel: 'asc' }, { language: 'asc' }, { createdAt: 'asc' }] });
  const needle = String(q || '').trim().toLowerCase();
  return rows.map(shape).filter((t) => !needle || `${t.name} ${t.purposeLabel} ${t.body} ${t.subject}`.toLowerCase().includes(needle));
}

async function get(id) {
  if (!supported()) return null;
  const row = await prisma.messageTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' } } } });
  if (!row) return null;
  return {
    ...shape(row),
    versions: row.versions.map((v) => ({
      id: v.id, version: v.version, subject: v.subject || '', body: v.body, active: v.active, waTemplateName: v.waTemplateName || '', waStatus: v.waStatus || '',
      dltTemplateId: v.dltTemplateId || '', senderId: v.senderId || '', changeNote: v.changeNote || '', changedByName: v.changedByName || null, createdAt: v.createdAt,
    })),
  };
}

// The purposes people can pick, with how many templates each has.
async function purposes({ audience } = {}) {
  const rows = await list({ audience });
  const map = new Map();
  rows.forEach((t) => {
    const e = map.get(t.purpose) || { purpose: t.purpose, label: t.purposeLabel, audience: t.audience, channels: [], languages: [] };
    if (!e.channels.includes(t.channel)) e.channels.push(t.channel);
    if (!e.languages.includes(t.language)) e.languages.push(t.language);
    map.set(t.purpose, e);
  });
  return [...map.values()];
}

// --- validate + write --------------------------------------------------------
function problemsIn(input, channel) {
  const errs = [];
  const body = String(input.body == null ? '' : input.body).trim();
  if (!body) errs.push('Write the message.');
  if (body.length > MAX_BODY[channel]) errs.push(`The message is too long for ${channel} (${body.length} of ${MAX_BODY[channel]} letters).`);
  if (channel === 'Email' && !String(input.subject || '').trim()) errs.push('An email needs a subject.');
  const bad = [...new Set([...unknownTokens(input.body), ...unknownTokens(input.subject)])];
  if (bad.length) errs.push(`These placeholders are not known: ${bad.map((b) => `{{${b}}}`).join(', ')}. Use the "Add a detail" buttons.`);
  return errs;
}
const slug = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

async function create(user, input) {
  const channel = CHANNELS.includes(input.channel) ? input.channel : null;
  if (!channel) return { error: 'Choose Email, SMS or WhatsApp.', status: 400 };
  const language = LANGUAGES.includes(input.language) ? input.language : 'English';
  const audience = AUDIENCES.includes(input.audience) ? input.audience : 'candidate';
  let purpose = String(input.purpose || '').trim();
  let label = String(input.purposeLabel || '').trim();
  if (!purpose || purpose === 'CUSTOM') {
    if (!label) return { error: 'Give this message a purpose name (for example "Salary discussion").', status: 400 };
    purpose = `CUSTOM_${slug(label)}`;
  } else if (!label) {
    const existing = await prisma.messageTemplate.findFirst({ where: { purpose } });
    label = existing ? existing.purposeLabel : purpose;
  }
  const errs = problemsIn(input, channel);
  if (errs.length) return { error: errs.join(' '), status: 400 };
  const name = String(input.name || label).trim().slice(0, 120);
  const admin = isAdmin(user);
  const sameSlot = await prisma.messageTemplate.count({ where: { purpose, channel, language, active: true } });
  const isDefault = sameSlot === 0 ? true : !!input.isDefault;
  const data = {
    purpose, purposeLabel: label, audience, channel, language, name,
    subject: channel === 'Email' ? String(input.subject).trim().slice(0, 200) : null,
    body: String(input.body).trim(), active: input.active !== false, isDefault, builtIn: false, version: 1,
    waTemplateName: channel === 'WhatsApp' && admin ? String(input.waTemplateName || '').trim().slice(0, 120) || null : null,
    waLanguageCode: channel === 'WhatsApp' && admin ? String(input.waLanguageCode || '').trim().slice(0, 12) || null : null,
    waStatus: channel === 'WhatsApp' && admin && WA_STATUSES.includes(input.waStatus) ? input.waStatus : 'None',
    waVars: channel === 'WhatsApp' && Array.isArray(input.waVars) ? JSON.stringify(input.waVars.map(canonOf).filter(Boolean)) : null,
    dltTemplateId: channel === 'SMS' && admin ? String(input.dltTemplateId || '').trim().slice(0, 60) || null : null,
    senderId: channel === 'SMS' && admin ? String(input.senderId || '').trim().slice(0, 30) || null : null,
    createdById: user.id, createdByName: user.name, updatedById: user.id, updatedByName: user.name,
  };
  const row = await prisma.$transaction(async (tx) => {
    if (isDefault && sameSlot) await tx.messageTemplate.updateMany({ where: { purpose, channel, language }, data: { isDefault: false } });
    return tx.messageTemplate.create({
      data: {
        ...data,
        versions: { create: [{ version: 1, subject: data.subject, body: data.body, active: data.active, waTemplateName: data.waTemplateName, waStatus: data.waStatus, waVars: data.waVars, dltTemplateId: data.dltTemplateId, senderId: data.senderId, changeNote: 'Created', changedById: user.id, changedByName: user.name }] },
      },
    });
  });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Message template created', entity: 'MessageTemplate', entityId: row.id, toValue: `${label} · ${channel} · ${language}` });
  return { template: shape(row) };
}

const EDITABLE = ['name', 'subject', 'body', 'active', 'waTemplateName', 'waLanguageCode', 'waStatus', 'waVars', 'dltTemplateId', 'senderId'];
const ADMIN_ONLY = ['waTemplateName', 'waLanguageCode', 'waStatus', 'dltTemplateId', 'senderId'];

async function update(user, id, input) {
  const row = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!row) return { error: 'No such template.', status: 404 };
  const cur = shape(row);
  const next = { ...cur };
  const changed = [];
  for (const k of EDITABLE) {
    if (input[k] === undefined) continue; // eslint-disable-line no-continue
    if (ADMIN_ONLY.includes(k) && !isAdmin(user)) {
      const same = JSON.stringify(input[k]) === JSON.stringify(cur[k]);
      if (!same) return { error: 'Only an Admin can change the WhatsApp name / approval or the SMS template id and sender id. They come from the Meta console and the SMS provider.', status: 403 };
      continue; // eslint-disable-line no-continue
    }
    let v = input[k];
    if (k === 'active') v = !!v;
    else if (k === 'waVars') v = Array.isArray(v) ? v.map(canonOf).filter(Boolean) : [];
    else v = String(v == null ? '' : v).trim();
    if (k === 'waStatus' && !WA_STATUSES.includes(v)) return { error: 'WhatsApp status must be Pending, Approved or Rejected.', status: 400 };
    if (JSON.stringify(v) !== JSON.stringify(cur[k])) { next[k] = v; changed.push(k); }
  }
  const errs = problemsIn(next, row.channel);
  if (errs.length) return { error: errs.join(' '), status: 400 };
  let makeDefault = false;
  if (input.isDefault === true && !cur.isDefault) { makeDefault = true; changed.push('isDefault'); }
  if (!changed.length) return { template: cur, unchanged: true };
  const bumps = changed.some((k) => k !== 'isDefault');
  const version = bumps ? row.version + 1 : row.version;
  const saved = await prisma.$transaction(async (tx) => {
    if (makeDefault) await tx.messageTemplate.updateMany({ where: { purpose: row.purpose, channel: row.channel, language: row.language }, data: { isDefault: false } });
    const upd = await tx.messageTemplate.update({
      where: { id },
      data: {
        name: next.name || row.name, subject: row.channel === 'Email' ? next.subject : null, body: next.body, active: next.active,
        ...(makeDefault ? { isDefault: true } : {}),
        waTemplateName: next.waTemplateName || null, waLanguageCode: next.waLanguageCode || null, waStatus: next.waStatus || 'None',
        waVars: next.waVars && next.waVars.length ? JSON.stringify(next.waVars) : null,
        dltTemplateId: next.dltTemplateId || null, senderId: next.senderId || null,
        version, updatedById: user.id, updatedByName: user.name,
      },
    });
    if (bumps) {
      await tx.messageTemplateVersion.create({
        data: {
          templateId: id, version, subject: upd.subject, body: upd.body, active: upd.active, waTemplateName: upd.waTemplateName, waStatus: upd.waStatus,
          waVars: upd.waVars, dltTemplateId: upd.dltTemplateId, senderId: upd.senderId,
          changeNote: String(input.changeNote || '').trim().slice(0, 200) || `Changed: ${changed.join(', ')}`, changedById: user.id, changedByName: user.name,
        },
      });
    }
    return upd;
  });
  await logAudit({
    userId: user.id, actorName: user.name, action: bumps ? `Message template edited (now version ${version})` : 'Message template made the default',
    entity: 'MessageTemplate', entityId: id, fromValue: `v${row.version}`, toValue: `${cur.purposeLabel} · ${cur.channel} · ${changed.join(', ')}`,
  });
  return { template: shape(saved) };
}

// Put an old version's wording back — as a NEW version, so history stays whole.
async function restore(user, id, version) {
  const v = await prisma.messageTemplateVersion.findFirst({ where: { templateId: id, version: Number(version) } });
  if (!v) return { error: 'That version does not exist.', status: 404 };
  return update(user, id, { subject: v.subject || '', body: v.body, changeNote: `Restored the wording of version ${v.version}` });
}

async function remove(user, id) {
  const row = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!row) return { error: 'No such template.', status: 404 };
  if (row.builtIn) return { error: 'The built-in wording cannot be deleted. Switch it off instead.', status: 409 };
  await prisma.messageTemplate.delete({ where: { id } });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Message template deleted', entity: 'MessageTemplate', entityId: id, fromValue: `${row.purposeLabel} · ${row.channel} · ${row.language}` });
  return { ok: true };
}

module.exports = {
  CHANNELS, LANGUAGES, WA_STATUSES, AUDIENCES, TOKENS, SAMPLE, MAX_BODY,
  canonOf, tokensIn, unknownTokens, render, smsInfo, waVarList,
  canEdit, canView, isAdmin, supported, ensureDefaults, resolve, list, get, purposes, create, update, restore, remove, problemsIn,
};
