// ---------------------------------------------------------------------------
// OUTREACH TEMPLATES (Email / WhatsApp / SMS). Own table (OutreachTemplate): the words of a PROMOTION, not of an ATS stage message.
//   Variables: {{name}} {{job_title}} {{company}} {{apply_link}} {{unsubscribe}}   (anything else is refused, with the name of the wrong one)
//   {{unsubscribe}} becomes the unsubscribe link in an email and "Reply STOP to opt out" in WhatsApp / SMS.
//   RULES when saving:
//     * a promotional template must carry opt-out instructions (email: {{unsubscribe}}; WhatsApp / SMS: {{unsubscribe}} or "Reply STOP")
//     * an INTERNAL template cannot use {{apply_link}} (internal messages never carry a tracked link)
//     * email needs a subject; SMS keeps DLT template id + sender id; WhatsApp keeps template name, language and approval status
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const { logAudit } = require('../utils/audit');

const VARS = ['name', 'job_title', 'company', 'apply_link', 'unsubscribe'];
const VAR_WORDS = { name: 'Their name', job_title: 'Job title', company: 'Company', apply_link: 'Apply link', unsubscribe: 'Opt-out line' };
const WA_STATUS = ['draft', 'pending', 'approved', 'rejected'];
const CHANNELS = ['email', 'whatsapp', 'sms'];
const SAMPLE = { name: 'Anita', job_title: 'ICU Staff Nurse', company: 'City Care Hospital', apply_link: 'https://example.org/jobs/apply?cid=SAMPLE', unsubscribe: '' };

// v3 (2026-10-17, Templates page): a category (WhatsApp's own three) and the rich WhatsApp / email layout (header, footer, buttons ...) kept in ONE side column `extra`.
// Category when nobody picked one: promotional -> Marketing, otherwise Utility.
const CATEGORIES = ['Marketing', 'Utility', 'Authentication'];
const HEADER_TYPES = ['none', 'text', 'image', 'video', 'document', 'location'];
const BUTTON_TYPES = { reply: 5, url: 2, phone: 1, whatsapp: 1, code: 1, flow: 1, order: 1 }; // button kind -> how many of it a template may carry
const catOf = (category, promotional) => (CATEGORIES.includes(category) ? category : (promotional ? 'Marketing' : 'Utility'));
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// the layout of a template as the screen sends it -> a clean object (unknown keys dropped, every text cut to size). Never throws.
function cleanExtra(x) {
  let v = x;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  if (HEADER_TYPES.includes(v.headerType)) out.headerType = v.headerType;
  if (v.headerText !== undefined) out.headerText = txt(v.headerText, 80);
  if (v.headerMedia && typeof v.headerMedia === 'object') out.headerMedia = { libraryId: txt(v.headerMedia.libraryId, 60), name: txt(v.headerMedia.name, 120), url: txt(v.headerMedia.url, 600) };
  if (v.location && typeof v.location === 'object') out.location = { name: txt(v.location.name, 100), address: txt(v.location.address, 200), lat: txt(v.location.lat, 20), lng: txt(v.location.lng, 20) };
  if (v.footer !== undefined) out.footer = txt(v.footer, 80);
  if (v.callPermission !== undefined) out.callPermission = !!v.callPermission;
  if (Array.isArray(v.buttons)) {
    out.buttons = v.buttons.slice(0, 12).map((b) => ({ type: Object.keys(BUTTON_TYPES).includes(b && b.type) ? b.type : 'reply', label: txt(b && b.label, 40), url: txt(b && b.url, 500), phone: txt(b && b.phone, 20), country: txt(b && b.country, 6), code: txt(b && b.code, 40), flow: txt(b && b.flow, 100) }));
  }
  if (v.review && typeof v.review === 'object') out.review = JSON.parse(JSON.stringify(v.review).slice(0, 8000));
  if (v.meta && typeof v.meta === 'object') out.meta = JSON.parse(JSON.stringify(v.meta).slice(0, 2000));
  if (v.bannerText !== undefined) out.bannerText = txt(v.bannerText, 200);
  return out;
}
const parseExtra = (s) => cleanExtra(s);

const varsIn = (text) => [...String(text || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
function unknownVars(...texts) {
  const bad = [];
  texts.forEach((t) => varsIn(t).forEach((v) => { if (!VARS.includes(v) && !bad.includes(v)) bad.push(v); }));
  return bad;
}
const hasStopWords = (text) => /\breply\s+stop\b|\bsend\s+stop\b|\btype\s+stop\b/i.test(String(text || ''));

// the problems of a template, in plain words ([] = fine)
function problems(t) {
  const out = [];
  const channel = t.channel; const body = String(t.body || ''); const subject = String(t.subject || '');
  if (!CHANNELS.includes(channel)) out.push('Pick Email, WhatsApp or SMS.');
  if (S.clip(t.name, 80).length < 2) out.push('Give the template a name.');
  if (!body.trim()) out.push('The message is empty.');
  const bad = unknownVars(body, subject);
  if (bad.length) out.push(`${bad.map((v) => `{{${v}}}`).join(', ')} ${bad.length > 1 ? 'are not known words' : 'is not a known word'}. You can use: ${VARS.map((v) => `{{${v}}}`).join(' ')}.`);
  if (channel === 'email' && !subject.trim()) out.push('An email needs a subject.');
  if (channel !== 'email' && /\{\{\s*subject\s*\}\}/.test(body)) out.push('Only email has a subject.');
  if (t.audience === 'internal' && varsIn(`${body} ${subject}`).includes('apply_link')) out.push('Internal messages cannot have an apply link ({{apply_link}}).');
  if (t.promotional) {
    const has = varsIn(`${body}`).includes('unsubscribe');
    if (channel === 'email' && !has) out.push('A promotion email must tell people how to stop it. Add {{unsubscribe}} to the message.');
    if (channel !== 'email' && !has && !hasStopWords(body)) out.push('A promotion must tell people how to stop it. Add {{unsubscribe}} or the words "Reply STOP to opt out".');
  }
  if (channel === 'sms' && t.dltTemplateId && !/^\d{10,25}$/.test(String(t.dltTemplateId).trim())) out.push('The DLT template number should be 10 to 25 digits.');
  if (channel === 'sms' && t.senderId && !/^[A-Za-z0-9]{3,11}$/.test(String(t.senderId).trim())) out.push('The sender ID should be 3 to 11 letters or numbers, with no spaces (for example GRNSRT).');
  if (t.category !== undefined && t.category !== null && t.category !== '' && !CATEGORIES.includes(t.category)) out.push('The category must be Marketing, Utility or Authentication.');
  if (channel === 'whatsapp' && t.extra && Array.isArray(t.extra.buttons)) {
    if (t.extra.buttons.length > 10) out.push('A WhatsApp template can have at most 10 buttons.');
    Object.keys(BUTTON_TYPES).forEach((k) => { if (t.extra.buttons.filter((b) => b.type === k).length > BUTTON_TYPES[k]) out.push(`Too many "${k}" buttons (at most ${BUTTON_TYPES[k]}).`); });
    if (t.extra.buttons.some((b) => b.label && b.label.length > 25)) out.push('A button label can have at most 25 letters.');
  }
  if (channel === 'whatsapp' && t.extra && t.extra.headerType === 'text' && String(t.extra.headerText || '').length > 60) out.push('The header text can have at most 60 letters.');
  if (channel === 'whatsapp' && t.extra && String(t.extra.footer || '').length > 60) out.push('The footer can have at most 60 letters.');
  if (channel === 'whatsapp' && t.waApprovalStatus && !WA_STATUS.includes(t.waApprovalStatus)) out.push('Unknown WhatsApp approval status.');
  return out;
}

// What can be used to send: WhatsApp needs the approved template, SMS needs the DLT ids (a note for people; Phase 3 enforces it)
function readiness(t) {
  if (t.status !== 'active') return { ready: false, why: 'Archived.' };
  if (t.channel === 'whatsapp' && t.waApprovalStatus !== 'approved') return { ready: false, why: 'WhatsApp has not approved this template yet, so it cannot be used.' }; // v3: a WhatsApp template can never be used before it is approved
  if (t.channel === 'sms' && t.promotional && !(t.dltTemplateId && t.senderId)) return { ready: false, why: 'Add the DLT template number and the sender ID.' };
  return { ready: true, why: '' };
}

// Fill in a message. ctx: { name, job_title, company, apply_link, unsubscribe } (unsubscribe = the link, for email).
function render(t, ctx = {}) {
  const channel = t.channel;
  const unsub = channel === 'email' ? (ctx.unsubscribe || '') : 'Reply STOP to opt out';
  const values = { name: ctx.name || '', job_title: ctx.job_title || '', company: ctx.company || '', apply_link: ctx.apply_link || '', unsubscribe: unsub };
  const fill = (s) => String(s || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (VARS.includes(v) ? values[v] : m));
  return { subject: fill(t.subject), body: fill(t.body), unknown: unknownVars(t.body, t.subject) };
}
const preview = (t) => render(t, { ...SAMPLE, unsubscribe: 'https://example.org/unsubscribe/SAMPLE' });

// Meta's positional view of a WhatsApp body: "Hi {{name}}, ..." -> "Hi {{1}}, ..." with the list of what {{1}} {{2}} stand for (the browser has a copy: templates/policy.js)
const waMapping = (body) => require('./tplPolicy').mapping(body); // eslint-disable-line global-require
const view = (r) => {
  const promotional = !!S.num(r.promotional);
  const t = {
    id: r.id, name: r.name, channel: r.channel, audience: r.audience, promotional, subject: r.subject || '', body: r.body, waTemplateName: r.waTemplateName || '', waLanguage: r.waLanguage || '',
    waApprovalStatus: r.waApprovalStatus || '', dltTemplateId: r.dltTemplateId || '', senderId: r.senderId || '', status: r.status, createdByName: r.createdByName || '', updatedAt: S.iso(r.updatedAt),
    category: catOf(r.category, promotional), extra: parseExtra(r.extra), createdAt: S.iso(r.createdAt),
  };
  return { ...t, ...readiness(t), ...(t.channel === 'whatsapp' ? { waMap: waMapping(t.body) } : {}) };
};

function canEdit(user, audience) { return audience === 'internal' ? A.mayRunInternal(user) : ['admin', 'bdetl', 'bde', 'tl', 'marketing'].includes(A.kind(user)); }

// how many campaigns and scheduled rules use a template (a template that was ever used is never deleted: it is the record of what was sent)
async function usageOf(ids) {
  const out = {}; (ids || []).forEach((id) => { out[id] = { campaigns: 0, rules: 0 }; });
  if (!ids || !ids.length) return out;
  try {
    if (await S.campaignsReady()) (await S.q(`SELECT templateId, COUNT(*) n FROM "OutreachCampaign" WHERE templateId IN (${ids.map(() => '?').join(',')}) GROUP BY templateId`, ...ids)).forEach((r) => { out[r.templateId].campaigns = S.num(r.n); });
  } catch { /* no campaigns table yet: nothing used it */ }
  try { (await require('./scheduled').loadRules()).forEach((r) => { if (out[r.templateId]) out[r.templateId].rules += 1; }); } catch { /* no rules */ } // eslint-disable-line global-require
  return out;
}
async function list(user, { type } = {}) {
  const aud = type === 'internal' ? 'internal' : 'candidate_lead';
  if (!A.mayRead(user, aud)) return [];
  const rows = await S.q('SELECT * FROM "OutreachTemplate" WHERE audience = ? AND status = \'active\' ORDER BY updatedAt DESC', aud);
  const used = aud === 'internal' ? await usageOf(rows.map((r) => r.id)) : {};
  return rows.map((r) => ({ ...view(r), ...(aud === 'internal' ? { usedByCampaigns: used[r.id].campaigns, usedByRules: used[r.id].rules } : {}) }));
}
async function get(user, id) {
  const r = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0];
  if (!r || !A.mayRead(user, r.audience)) return null;
  return r;
}
function fromBody(b, cur = {}) {
  const channel = b.channel !== undefined ? String(b.channel) : cur.channel;
  return {
    name: b.name !== undefined ? S.clip(b.name, 80) : cur.name, channel, audience: (b.audience || cur.audience) === 'internal' ? 'internal' : 'candidate_lead',
    promotional: b.promotional !== undefined ? !!b.promotional : (cur.promotional === undefined ? true : !!S.num(cur.promotional)),
    subject: b.subject !== undefined ? S.clip(b.subject, 200) : cur.subject, body: b.body !== undefined ? String(b.body).slice(0, 4000) : cur.body,
    waTemplateName: b.waTemplateName !== undefined ? S.clip(b.waTemplateName, 120) : cur.waTemplateName, waLanguage: b.waLanguage !== undefined ? S.clip(b.waLanguage, 12) : cur.waLanguage,
    waApprovalStatus: b.waApprovalStatus !== undefined ? S.clip(b.waApprovalStatus, 20) : cur.waApprovalStatus, dltTemplateId: b.dltTemplateId !== undefined ? S.clip(b.dltTemplateId, 30) : cur.dltTemplateId,
    senderId: b.senderId !== undefined ? S.clip(b.senderId, 20) : cur.senderId,
    category: b.category !== undefined ? S.clip(b.category, 20) : cur.category,
    // the layout the screen sends; the review / Meta records are written by the server only, so a screen can never fake an approval
    extra: b.extra !== undefined ? (() => { const c = parseExtra(cur.extra); const n = cleanExtra(b.extra); delete n.review; delete n.meta; if (c.review) n.review = c.review; if (c.meta) n.meta = c.meta; return n; })() : parseExtra(cur.extra),
  };
}
// category + layout are separate, guarded writes: a database that has not got the two columns yet keeps working exactly as before
async function saveExtras(id, t) {
  try { await S.run('UPDATE "OutreachTemplate" SET category = ?, extra = ? WHERE id = ?', catOf(t.category, t.promotional), JSON.stringify(t.extra && typeof t.extra === 'object' ? t.extra : {}), id); } catch { /* columns not there yet */ }
}
async function create(user, b) {
  const t = fromBody(b);
  if (!canEdit(user, t.audience)) return { error: 'You cannot write this kind of template.', status: 403 };
  const p = problems(t);
  if (p.length) return { error: p[0], problems: p, status: 400 };
  const dup = (await S.q('SELECT id FROM "OutreachTemplate" WHERE LOWER(name) = LOWER(?) AND channel = ? AND audience = ? AND status = \'active\'', t.name, t.channel, t.audience))[0];
  if (dup) return { error: `You already have a ${t.channel} template called "${t.name}".`, status: 409 };
  const id = S.newId('ot'); const now = Date.now();
  await S.run(`INSERT INTO "OutreachTemplate" (id, name, channel, audience, promotional, subject, body, waTemplateName, waLanguage, waApprovalStatus, dltTemplateId, senderId, status, createdById, createdByName, createdAt, updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`, id, t.name, t.channel, t.audience, t.promotional ? 1 : 0, t.subject || null, t.body, t.waTemplateName || null, t.waLanguage || null,
  t.channel === 'whatsapp' ? (t.waApprovalStatus || 'draft') : null, t.dltTemplateId || null, t.senderId || null, user.id, user.name, now, now);
  await saveExtras(id, t);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach template created', entity: 'OutreachTemplate', entityId: id, toValue: `${t.name} (${t.channel}, ${t.audience})` });
  return { template: view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0]) };
}
async function update(user, id, b) {
  const cur = await get(user, id);
  if (!cur || cur.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (!canEdit(user, cur.audience)) return { error: 'You cannot change this template.', status: 403 };
  const t = fromBody({ ...b, channel: cur.channel, audience: cur.audience }, cur);
  const p = problems(t);
  if (p.length) return { error: p[0], problems: p, status: 400 };
  await S.run('UPDATE "OutreachTemplate" SET name = ?, promotional = ?, subject = ?, body = ?, waTemplateName = ?, waLanguage = ?, waApprovalStatus = ?, dltTemplateId = ?, senderId = ?, updatedAt = ? WHERE id = ?',
    t.name, t.promotional ? 1 : 0, t.subject || null, t.body, t.waTemplateName || null, t.waLanguage || null, t.channel === 'whatsapp' ? (t.waApprovalStatus || 'draft') : null, t.dltTemplateId || null, t.senderId || null, Date.now(), id);
  await saveExtras(id, t);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach template changed', entity: 'OutreachTemplate', entityId: id, toValue: t.name });
  return { template: view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0]) };
}
// a copy with a free name ("Name (copy)", "Name (copy 2)" ...), same channel and audience, same rules as a new template
async function duplicate(user, id) {
  const cur = await get(user, id);
  if (!cur || cur.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (!canEdit(user, cur.audience)) return { error: 'You cannot write this kind of template.', status: 403 };
  const names = new Set((await S.q('SELECT name FROM "OutreachTemplate" WHERE channel = ? AND audience = ? AND status = \'active\'', cur.channel, cur.audience)).map((r) => String(r.name).toLowerCase()));
  let name = `${S.clip(cur.name, 70)} (copy)`; let n = 2;
  while (names.has(name.toLowerCase())) { name = `${S.clip(cur.name, 66)} (copy ${n})`; n += 1; }
  return create(user, { name, channel: cur.channel, audience: cur.audience, promotional: !!S.num(cur.promotional), subject: cur.subject || '', body: cur.body, waTemplateName: cur.waTemplateName || '', waLanguage: cur.waLanguage || '', waApprovalStatus: cur.channel === 'whatsapp' ? 'draft' : '', dltTemplateId: cur.dltTemplateId || '', senderId: cur.senderId || '', category: cur.category || undefined, extra: (() => { const e = parseExtra(cur.extra); delete e.review; delete e.meta; return e; })() });
}
async function archive(user, id) {
  const cur = await get(user, id);
  if (!cur || cur.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (!canEdit(user, cur.audience)) return { error: 'You cannot remove this template.', status: 403 };
  if (cur.audience === 'internal') { // a staff template that was ever used stays (it is the record of what was sent)
    const u = (await usageOf([id]))[id];
    if (u.campaigns > 0 || u.rules > 0) return { error: `This message is used by ${u.campaigns} sent message${u.campaigns === 1 ? '' : 's'}${u.rules ? ` and ${u.rules} scheduled rule${u.rules === 1 ? '' : 's'}` : ''}, so it cannot be deleted. Make a copy and change the copy instead.`, status: 409, code: 'in_use' };
  }
  await S.run('UPDATE "OutreachTemplate" SET status = \'archived\', updatedAt = ? WHERE id = ?', Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach template archived', entity: 'OutreachTemplate', entityId: id, toValue: cur.name });
  return { ok: true };
}

module.exports = { canEdit, CATEGORIES, HEADER_TYPES, BUTTON_TYPES, catOf, cleanExtra, parseExtra, waMapping, saveExtras, duplicate, usageOf, VARS, VAR_WORDS, SAMPLE, problems, readiness, render, preview, view, list, get, create, update, archive, unknownVars, fromBody };
