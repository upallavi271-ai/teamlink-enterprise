// ---------------------------------------------------------------------------
// RCS (rich messages): the assistants (agents) the 5-step wizard makes and the RCS templates (plain text / card / carousel) of each agent.
// EVERYTHING HERE IS ONLY SAVED. RCS sending is planned: no carrier is called, nothing is sent, nothing is "verified" after a few seconds.
// An agent has the status "saved" (saved here, not sent to a carrier); a template is "draft" (Not sent yet) until its fields pass the check, then "saved".
// Tables: OmniRcsAgent, OmniRcsTemplate (outreach/tplOwn.js). Pictures come from the Library (libraryId + url).
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const Own = require('./tplOwn');
const { logAudit } = require('../utils/audit');

const AGENT_CATEGORIES = ['Conversational', 'OTP', 'Promotional', 'Transactional', 'Multi-use'];
const BILLING = ['Basic Message', 'Single Message', 'Conversational', 'Basic Message + SMS'];
const TYPES = { text: 'Plain Text', card: 'Standalone Card', carousel: 'Carousel' };
const ACTION_TYPES = { reply: 'Suggested Reply', url: 'Open URL', dial: 'Dial Phone', location: 'View Location', calendar: 'Calendar Event' };
const MAX_ACTIONS = { text: 3, card: 4, carousel: 4 };
const HEIGHTS = { short: 'SHORT_HEIGHT', medium: 'MEDIUM_HEIGHT', tall: 'TALL_HEIGHT' };

const txt = (v, n) => S.clip(v, n);
const httpsUrl = (v) => /^https:\/\/[^\s/$.?#][^\s]*$/i.test(String(v || '').trim());
const digits = (v) => String(v || '').replace(/\D/g, '');
const media = (m) => (m && typeof m === 'object' && (m.libraryId || m.url) ? { libraryId: txt(m.libraryId, 60), name: txt(m.name, 120), url: txt(m.url, 600) } : null);

// ---- agents (the wizard) ---------------------------------------------------------------------------------
function cleanAgent(d0) {
  const d = d0 || {};
  const rows = (arr, keys, max) => (Array.isArray(arr) ? arr.slice(0, max).map((r) => Object.fromEntries(keys.map((k) => [k, txt(r && r[k], 200)]))) : []);
  return {
    name: txt(d.name, 40), category: txt(d.category, 30), billing: txt(d.billing, 30), description: txt(d.description, 100), theme: txt(d.theme, 7) || '#11985a',
    cover: media(d.cover), icon: media(d.icon),
    contact: { name: txt(d.contact && d.contact.name, 80), mobile: txt(d.contact && d.contact.mobile, 20), designation: txt(d.contact && d.contact.designation, 80), email: txt(d.contact && d.contact.email, 120) },
    phones: rows(d.phones, ['label', 'number'], 5), websites: rows(d.websites, ['url'], 5), emails: rows(d.emails, ['email'], 5),
    privacyUrl: txt(d.privacyUrl, 300), termsUrl: txt(d.termsUrl, 300), brand: txt(d.brand, 120), brandSite: txt(d.brandSite, 300),
    testers: (Array.isArray(d.testers) ? d.testers : String(d.testers || '').split(/[\n,]+/)).map((x) => txt(x, 20)).filter(Boolean).slice(0, 20),
  };
}
// the errors of one wizard step (1 Basic, 2 Branding, 3 Contact, 4 Verification); first one is shown
function agentErrors(d, step) {
  const e = [];
  if (step === 1) {
    if (d.name.length < 3) e.push('Assistant name needs at least 3 characters.');
    if (!AGENT_CATEGORIES.includes(d.category)) e.push('Pick an assistant category.');
    if (!BILLING.includes(d.billing)) e.push('Pick a billing category.');
    if (d.description.length < 10) e.push('Write a description of at least 10 characters.');
  }
  if (step === 2) {
    if (!/^#[0-9a-fA-F]{6}$/.test(d.theme)) e.push('Theme colour must be a six-digit hex value.');
    if (!d.cover) e.push('A cover image is required.');
    if (!d.icon) e.push('An icon image is required.');
  }
  if (step === 3) {
    if (!d.contact.name) e.push('Contact person: full name is required.');
    if (digits(d.contact.mobile).length < 10) e.push('Contact person: mobile number needs at least 10 digits.');
    if (!d.contact.designation) e.push('Contact person: designation is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contact.email)) e.push('Contact person: use a valid email address.');
    if (!d.phones.length || !d.phones[0].number) e.push('Business phone 1 is required.');
    d.phones.forEach((p, i) => { if (p.number && digits(p.number).length < 7) e.push(`Business phone ${i + 1} is incomplete.`); });
    if (!d.websites.length || !httpsUrl(d.websites[0].url)) e.push('Business website: use a full URL starting with https://.');
    d.websites.forEach((w, i) => { if (i > 0 && w.url && !httpsUrl(w.url)) e.push(`Business website ${i + 1}: use a full URL starting with https://.`); });
    if (!d.emails.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.emails[0].email)) e.push('Business email: use a valid email address.');
    if (!httpsUrl(d.privacyUrl)) e.push('Privacy policy: use a full URL starting with https://.');
    if (!httpsUrl(d.termsUrl)) e.push('Terms and conditions: use a full URL starting with https://.');
  }
  if (step === 4) {
    if (!d.brand) e.push('The registered brand name is required for carrier verification.');
    if (d.brandSite && !httpsUrl(d.brandSite)) e.push('Brand website: use a full URL starting with https://.');
    d.testers.forEach((t) => { if (digits(t).length < 10) e.push(`Test device "${t}" is not a valid number.`); });
  }
  return e;
}
const agentView = (r, n = 0) => ({ id: r.id, name: r.name, status: r.status || 'saved', statusWord: 'Saved here, not sent to a carrier', data: Own.parse(r.data, {}), templates: n, createdByName: r.createdByName || '', updatedAt: S.iso(r.updatedAt), department: r.department || '', audience: r.audience });

async function agents(u) {
  await Own.ensure();
  const rows = (await S.q('SELECT * FROM "OmniRcsAgent" WHERE deletedAt IS NULL ORDER BY name COLLATE NOCASE')).filter((r) => Own.sees(u, r));
  const counts = {}; (await S.q('SELECT agentId, COUNT(*) n FROM "OmniRcsTemplate" WHERE deletedAt IS NULL GROUP BY agentId')).forEach((c) => { counts[c.agentId] = S.num(c.n); });
  return rows.map((r) => agentView(r, counts[r.id] || 0));
}
async function getAgent(u, id) {
  await Own.ensure();
  const r = (await S.q('SELECT * FROM "OmniRcsAgent" WHERE id = ?', String(id || '')))[0];
  return r && Own.sees(u, r) ? r : null;
}
async function createAgent(u, b, dept) {
  await Own.ensure();
  if (!Own.mayWrite(u)) return { error: 'You cannot make RCS assistants.', status: 403 };
  const d = cleanAgent(b.data || b);
  for (const step of [1, 2, 3, 4]) { const e = agentErrors(d, step); if (e.length) return { error: e[0], step, status: 400 }; }
  if (await Own.nameClash('OmniRcsAgent', d.name)) return { error: `There is already an assistant called "${d.name}".`, status: 409 };
  const id = S.newId('ra'); const now = Date.now();
  await S.run('INSERT INTO "OmniRcsAgent" (id, name, status, data, audience, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', id, d.name, 'saved', JSON.stringify(d), Own.audienceOfWriter(u), dept || null, u.id, u.name, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'RCS assistant saved', entity: 'OmniRcsAgent', entityId: id, toValue: d.name });
  return { agent: agentView((await S.q('SELECT * FROM "OmniRcsAgent" WHERE id = ?', id))[0]) };
}
async function updateAgent(u, id, b) {
  const r = await getAgent(u, id);
  if (!r) return { error: 'This assistant was not found.', status: 404 };
  if (!Own.mayChange(u, r)) return { error: 'You cannot change this assistant.', status: 403 };
  const d = cleanAgent(b.data || b);
  for (const step of [1, 2, 3, 4]) { const e = agentErrors(d, step); if (e.length) return { error: e[0], step, status: 400 }; }
  if (await Own.nameClash('OmniRcsAgent', d.name, r.id)) return { error: `There is already an assistant called "${d.name}".`, status: 409 };
  await S.run('UPDATE "OmniRcsAgent" SET name = ?, data = ?, updatedAt = ? WHERE id = ?', d.name, JSON.stringify(d), Date.now(), r.id);
  return { agent: agentView((await S.q('SELECT * FROM "OmniRcsAgent" WHERE id = ?', r.id))[0]) };
}
async function removeAgent(u, id) {
  const r = await getAgent(u, id);
  if (!r) return { error: 'This assistant was not found.', status: 404 };
  if (!Own.mayChange(u, r)) return { error: 'You cannot delete this assistant.', status: 403 };
  const n = S.num((await S.q('SELECT COUNT(*) n FROM "OmniRcsTemplate" WHERE agentId = ? AND deletedAt IS NULL', r.id))[0].n);
  if (n) return { error: `This assistant still has ${n} template${n === 1 ? '' : 's'}. Delete those first.`, status: 409 };
  await S.run('UPDATE "OmniRcsAgent" SET deletedAt = ? WHERE id = ?', Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'RCS assistant deleted', entity: 'OmniRcsAgent', entityId: r.id });
  return { ok: true };
}

// ---- templates ---------------------------------------------------------------------------------------------
const blankCard = () => ({ title: '', description: '', orientation: 'vertical', mediaHeight: 'medium', media: null, actions: [] });
function cleanForm(type, f0) {
  const f = f0 || {};
  const actions = (arr) => (Array.isArray(arr) ? arr.slice(0, MAX_ACTIONS[type] || 4).map((a) => ({ type: Object.keys(ACTION_TYPES).includes(a && a.type) ? a.type : 'reply', label: txt(a && a.label, 25), url: txt(a && a.url, 500), phone: txt(a && a.phone, 25), place: txt(a && a.place, 200), event: txt(a && a.event, 120) })) : []);
  const card = (c) => ({ title: txt(c && c.title, 80), description: txt(c && c.description, 2000), orientation: ['vertical', 'horizontal'].includes(c && c.orientation) ? c.orientation : 'vertical', mediaHeight: Object.keys(HEIGHTS).includes(c && c.mediaHeight) ? c.mediaHeight : 'medium', media: media(c && c.media), actions: actions(c && c.actions) });
  if (type === 'text') return { text: String((f && f.text) || '').slice(0, 2000), actions: actions(f.actions) };
  if (type === 'card') return card(f);
  return { cards: (Array.isArray(f.cards) ? f.cards : []).slice(0, 10).map(card) };
}
// the first error of a template that is being saved ('' = fine)
function formError(type, form) {
  const actionError = (a) => {
    if (!a.label) return 'A button has no label.';
    const need = { url: ['url', 'a web address'], dial: ['phone', 'a phone number'], location: ['place', 'a place or address'], calendar: ['event', 'an event title'] }[a.type];
    if (need && !a[need[0]]) return `Button "${a.label}" needs ${need[1]}.`;
    if (a.type === 'url' && !/^https?:\/\//i.test(a.url)) return `Button "${a.label}" needs a full web address (https://...).`;
    return '';
  };
  if (type === 'text') return (!form.text.trim() ? 'Message text cannot be empty.' : '') || form.actions.map(actionError).find(Boolean) || '';
  if (type === 'card') return (!form.title && !form.description ? 'Give the card a title or a description.' : '') || form.actions.map(actionError).find(Boolean) || '';
  const filled = form.cards.filter((c) => c.title || c.description);
  if (filled.length < 2) return 'A carousel needs at least 2 cards with content.';
  return form.cards.map((c) => c.actions.map(actionError).find(Boolean)).find(Boolean) || '';
}
const tplView = (r, agent) => ({ id: r.id, agentId: r.agentId, agentName: agent ? agent.name : '', name: r.name, type: r.type, typeWord: TYPES[r.type] || r.type, status: r.status, statusWord: r.status === 'saved' ? 'Saved' : 'Not sent yet', form: Own.parse(r.form, {}), updatedAt: S.iso(r.updatedAt), createdByName: r.createdByName || '' });

async function templates(u, { agentId = '', q = '', type = '' } = {}) {
  await Own.ensure();
  const rows = (await S.q('SELECT * FROM "OmniRcsTemplate" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 2000')).filter((r) => Own.sees(u, r));
  const names = {}; (await S.q('SELECT id, name FROM "OmniRcsAgent" WHERE deletedAt IS NULL')).forEach((a) => { names[a.id] = { name: a.name }; });
  const needle = String(q || '').trim().toLowerCase();
  return rows.filter((r) => (!agentId || r.agentId === agentId) && (!type || r.type === type) && (!needle || String(r.name).toLowerCase().includes(needle))).map((r) => tplView(r, names[r.agentId]));
}
async function getTemplate(u, id) {
  await Own.ensure();
  const r = (await S.q('SELECT * FROM "OmniRcsTemplate" WHERE id = ?', String(id || '')))[0];
  return r && Own.sees(u, r) ? r : null;
}
async function createTemplate(u, b, dept) {
  await Own.ensure();
  if (!Own.mayWrite(u)) return { error: 'You cannot write templates.', status: 403 };
  const agent = await getAgent(u, b.agentId);
  if (!agent) return { error: 'Pick the RCS assistant this template belongs to.', status: 400 };
  const name = txt(b.name, 80);
  if (name.length < 2) return { error: 'Give the template a name.', status: 400 };
  const type = Object.keys(TYPES).includes(b.type) ? b.type : 'text';
  if (await Own.nameClash('OmniRcsTemplate', name, '', 'AND agentId = ?', agent.id)) return { error: `This account already has a template called "${name}".`, status: 409 };
  const form = type === 'carousel' ? { cards: [blankCard(), blankCard()] } : (type === 'card' ? blankCard() : { text: '', actions: [] });
  const id = S.newId('rt'); const now = Date.now();
  await S.run('INSERT INTO "OmniRcsTemplate" (id, agentId, name, type, status, form, audience, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, agent.id, name, type, 'draft', JSON.stringify(form), agent.audience, dept || agent.department || null, u.id, u.name, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'RCS template created', entity: 'OmniRcsTemplate', entityId: id, toValue: name });
  return { template: tplView((await S.q('SELECT * FROM "OmniRcsTemplate" WHERE id = ?', id))[0], { name: agent.name }) };
}
// save: a rename alone (just `name`) always works; with `form` the fields are checked and, when fine, the template becomes "saved"
async function updateTemplate(u, id, b) {
  const r = await getTemplate(u, id);
  if (!r) return { error: 'This template was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot change this template.', status: 403 };
  let name = r.name;
  if (b.name !== undefined) {
    name = txt(b.name, 80);
    if (name.length < 2) return { error: 'Give the template a name.', status: 400 };
    if (await Own.nameClash('OmniRcsTemplate', name, r.id, 'AND agentId = ?', r.agentId)) return { error: `This account already has a template called "${name}".`, status: 409 };
  }
  let form = Own.parse(r.form, {}); let status = r.status;
  if (b.form !== undefined) {
    form = cleanForm(r.type, b.form);
    const err = formError(r.type, form);
    if (err) return { error: err, status: 400 };
    status = 'saved';
  }
  await S.run('UPDATE "OmniRcsTemplate" SET name = ?, form = ?, status = ?, updatedAt = ? WHERE id = ?', name, JSON.stringify(form), status, Date.now(), r.id);
  const agent = (await S.q('SELECT name FROM "OmniRcsAgent" WHERE id = ?', r.agentId))[0];
  return { template: tplView((await S.q('SELECT * FROM "OmniRcsTemplate" WHERE id = ?', r.id))[0], agent) };
}
async function duplicateTemplate(u, id) {
  const r = await getTemplate(u, id);
  if (!r) return { error: 'This template was not found.', status: 404 };
  if (!Own.mayWrite(u)) return { error: 'You cannot write templates.', status: 403 };
  let name = `${r.name} copy`; let n = 2;
  while (await Own.nameClash('OmniRcsTemplate', name, '', 'AND agentId = ?', r.agentId)) { name = `${r.name} copy ${n}`; n += 1; } // eslint-disable-line no-await-in-loop
  const nid = S.newId('rt'); const now = Date.now();
  await S.run('INSERT INTO "OmniRcsTemplate" (id, agentId, name, type, status, form, audience, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', nid, r.agentId, name, r.type, 'draft', r.form, r.audience, r.department || null, u.id, u.name, now, now);
  const agent = (await S.q('SELECT name FROM "OmniRcsAgent" WHERE id = ?', r.agentId))[0];
  return { template: tplView((await S.q('SELECT * FROM "OmniRcsTemplate" WHERE id = ?', nid))[0], agent) };
}
async function removeTemplate(u, id) {
  const r = await getTemplate(u, id);
  if (!r) return { error: 'This template was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot delete this template.', status: 403 };
  await S.run('UPDATE "OmniRcsTemplate" SET deletedAt = ? WHERE id = ?', Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'RCS template deleted', entity: 'OmniRcsTemplate', entityId: r.id });
  return { ok: true };
}

// the JSON a carrier would receive (preview only: nothing is sent). base = the site address for picture links.
function payload(type, form, base = '') {
  const sug = (acts) => (acts || []).map((a) => {
    if (a.type === 'reply') return { reply: { text: a.label, postbackData: `reply_${String(a.label).toLowerCase().replace(/\W+/g, '_')}` } };
    const action = { text: a.label };
    if (a.type === 'url') action.openUrlAction = { url: a.url };
    if (a.type === 'dial') action.dialAction = { phoneNumber: a.phone };
    if (a.type === 'location') action.viewLocationAction = { query: a.place };
    if (a.type === 'calendar') action.createCalendarEventAction = { title: a.event };
    return { action };
  });
  const cardContent = (c) => ({ title: c.title, description: c.description, ...(c.media ? { media: { height: HEIGHTS[c.mediaHeight] || 'MEDIUM_HEIGHT', contentInfo: { fileUrl: `${base}${c.media.url}` } } } : {}), suggestions: sug(c.actions) });
  let content;
  if (type === 'text') content = { plainText: form.text, suggestions: sug(form.actions) };
  else if (type === 'card') content = { standaloneCard: { cardOrientation: form.orientation === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL', cardContent: cardContent(form) } };
  else content = { carouselCard: { cardWidth: 'MEDIUM', cardContents: (form.cards || []).map(cardContent) } };
  return { messageID: 'PREVIEW_MESSAGE_ID', agentID: 'PREVIEW_AGENT_ID', campaignID: 'generated_campaign', contacts: ['+91XXXXXXXXXX'], data: { content } };
}

module.exports = { AGENT_CATEGORIES, BILLING, TYPES, ACTION_TYPES, MAX_ACTIONS, agents, getAgent, createAgent, updateAgent, removeAgent, agentErrors, cleanAgent, templates, getTemplate, createTemplate, updateTemplate, duplicateTemplate, removeTemplate, cleanForm, formError, payload };
