// ---------------------------------------------------------------------------
// CRM WAVE C - LEADS IN AND WHO GETS THEM:
//   01.06 assignment rules: "source is IndiaMART -> Ravi, Sita (in turn)", "city contains Hyderabad -> Kiran", "industry is Healthcare and
//         state is Telangana -> ..." - the first rule that matches gives the lead, in turn among its people. OFF until a Sales manager / Admin
//         turns it on (CRM settings > Customise > Lead routing); used for the website form, every source below, and a "+ Lead" saved with the
//         owner left empty. "Re-run rules" on ticked leads uses them even while the switch is off.
//   01.11 leads from an inbound email (SendGrid / Mailgun inbound parse, or any mail-to-webhook service), the chat box on the website, Facebook /
//         Instagram lead ads (Meta webhook: verify token + signed POST, the lead read from the Graph API with the page token), LinkedIn lead-gen
//         forms and Google Ads lead forms (their webhooks / Zapier), and a plain JSON webhook. Public door: /api/crm/capture/<source>
//         (routes/crmCapture.js), each source OFF until switched on, the CRM's capture key in the address / header.
//   01.14 India portals: IndiaMART (the CRM pull API every N minutes, or its push), TradeIndia (the inquiry API), JustDial (its push).
// The keys live in Administration > Integrations ("CRM lead ads (Meta)", "CRM India portals"); a test server never calls the outside.
// A lead whose phone or email is already a lead becomes a note on that lead (like the website form).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const P = require('./db');
const S = require('../service');
const SETTINGS = require('../settings');

const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : ''; };
const mayAdmin = (user) => S.mayAssign(S.roleOf(user));
const testServer = () => !!(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX);

// ---- assignment rules -------------------------------------------------------------------------------------------------
const RULE_FIELDS = { source: 'Source', city: 'City', state: 'State', industry: 'Industry', rating: 'Rating', company: 'Company', product: 'Product / interest', utmSource: 'Campaign source (UTM)', utmCampaign: 'Campaign name (UTM)', designation: 'Designation' };
const RULE_OPS = { is: 'is', contains: 'contains', isNot: 'is not' };
const ruleOut = (x) => ({ id: x.id, name: x.name, position: x.position, active: !!x.active, match: P.parse(x.matchJson, []), ownerIds: P.parse(x.ownerIdsJson, []), hits: x.hits || 0, lastOwnerId: x.lastOwnerId || null });
async function rulesList(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const cfg = await P.config();
  const rows = (await P.all('SELECT * FROM "CrmAssignRule" ORDER BY "position", "createdAt"')).map(ruleOut);
  const custom = (await require('./fields').defs('lead')).map((d) => ({ key: d.key, label: d.label })); // eslint-disable-line global-require
  return S.okBody({ on: cfg.assignRulesOn, rules: rows, fields: { ...RULE_FIELDS, ...Object.fromEntries(custom.map((c) => [c.key, c.label])) }, ops: RULE_OPS, people: S.mayAssign(S.roleOf(user)) ? await S.ownerOptions() : [], canEdit: mayAdmin(user) });
}
function cleanMatch(list) {
  return (Array.isArray(list) ? list : []).map((m) => ({ field: clip(m && m.field, 60), op: RULE_OPS[m && m.op] ? m.op : 'is', value: clip(m && m.value, 300) }))
    .filter((m) => m.field && (RULE_FIELDS[m.field] || /^cf_/.test(m.field)) && m.value).slice(0, 8);
}
async function ruleSave(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead routing is set by a Sales manager or an Admin.');
  const name = clip(body.name, 80) || 'Rule';
  const match = cleanMatch(body.match);
  if (!match.length) return S.fail(400, 'Add at least one "when" line (for example: Source is IndiaMART).');
  const team = await S.ownerOptions();
  const ownerIds = [...new Set((Array.isArray(body.ownerIds) ? body.ownerIds : []).map((x) => clip(x, 60)))].filter((id) => team.some((o) => o.id === id)).slice(0, 30);
  if (!ownerIds.length) return S.fail(400, 'Pick who gets these leads (one or more people from the sales team, in turn).');
  const now = P.nowIso();
  if (body.id) {
    const was = await P.one('SELECT * FROM "CrmAssignRule" WHERE "id" = ?', clip(body.id, 60));
    if (!was) return S.fail(404, 'This rule is not there.');
    await P.run('UPDATE "CrmAssignRule" SET "name" = ?, "matchJson" = ?, "ownerIdsJson" = ?, "active" = ?, "position" = ?, "updatedAt" = ? WHERE "id" = ?', name, JSON.stringify(match), JSON.stringify(ownerIds), body.active === false ? 0 : 1, Number.isFinite(Number(body.position)) ? Math.round(Number(body.position)) : was.position, now, was.id);
    await S.audit(user, 'CRM lead rule changed', 'CrmAssignRule', was.id, name);
  } else {
    const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmAssignRule"');
    await P.run('INSERT INTO "CrmAssignRule" ("id", "name", "position", "active", "matchJson", "ownerIdsJson", "lastOwnerId", "hits", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)', P.newId('arule'), name, (Number(n && n.n) + 1) * 10, body.active === false ? 0 : 1, JSON.stringify(match), JSON.stringify(ownerIds), now, now);
    await S.audit(user, 'CRM lead rule added', 'CrmAssignRule', name, match.map((m) => `${m.field} ${m.op} ${m.value}`).join(' and '));
  }
  return rulesList(user);
}
async function ruleRemove(user, id) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead routing is set by a Sales manager or an Admin.');
  await P.run('DELETE FROM "CrmAssignRule" WHERE "id" = ?', clip(id, 60));
  await S.audit(user, 'CRM lead rule removed', 'CrmAssignRule', clip(id, 60), '');
  return rulesList(user);
}
async function rulesSwitch(user, on) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead routing is set by a Sales manager or an Admin.');
  await P.saveConfig({ assignRulesOn: on === true });
  await S.audit(user, `CRM lead routing ${on === true ? 'switched on' : 'switched off'}`, 'AppSetting', 'crm.plus', '');
  return rulesList(user);
}
const valueOf = (lead, field, extra = {}) => {
  if (field === 'product') return [extra.products, lead.notes].filter(Boolean).join(' ');
  if (/^cf_/.test(field)) { const c = P.parse(lead.customJson, {}); const v = c[field] != null ? c[field] : (extra.custom || {})[field]; return Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v); }
  return String(lead[field] == null ? '' : lead[field]);
};
function matches(rule, lead, extra) {
  return rule.match.every((m) => {
    const v = valueOf(lead, m.field, extra).toLowerCase();
    const wants = m.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (m.op === 'contains') return wants.some((w) => v.includes(w));
    if (m.op === 'isNot') return !wants.includes(v.trim());
    return wants.includes(v.trim());
  });
}
/** The owner the rules give this lead (the turn moves on), or null. `force` runs them even while routing is switched off; `dry` does not move the turn. */
async function ownerFor(lead, { force = false, dry = false, extra = {} } = {}) {
  const cfg = await P.config();
  if (!cfg.assignRulesOn && !force) return null;
  const team = await S.ownerOptions();
  const rules = (await P.all('SELECT * FROM "CrmAssignRule" WHERE "active" = 1 ORDER BY "position", "createdAt"')).map(ruleOut);
  for (const rule of rules) {
    if (!matches(rule, lead, extra)) continue; // eslint-disable-line no-continue
    const people = rule.ownerIds.map((id) => team.find((o) => o.id === id)).filter(Boolean); // somebody who left the team is skipped
    if (!people.length) continue; // eslint-disable-line no-continue
    // re-read just before the turn moves, so two leads at once do not both go to the same person
    const fresh = await P.one('SELECT "lastOwnerId" FROM "CrmAssignRule" WHERE "id" = ?', rule.id);
    const i = people.findIndex((o) => o.id === (fresh && fresh.lastOwnerId));
    const next = people[(i + 1) % people.length];
    if (!dry) await P.run('UPDATE "CrmAssignRule" SET "lastOwnerId" = ?, "hits" = "hits" + 1 WHERE "id" = ?', next.id, rule.id);
    return { id: next.id, name: next.name, rule: rule.name };
  }
  return null;
}
async function ruleTest(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead routing is set by a Sales manager or an Admin.');
  const own = await ownerFor(body, { force: true, dry: true, extra: { products: body.product } });
  return S.okBody({ owner: own });
}

// ---- leads coming in from outside ------------------------------------------------------------------------------------------
const SOURCE_NAME = { webhook: 'Other', whatsapp: 'WhatsApp', email: 'Email', chat: 'Chat', facebook: 'Facebook lead ads', linkedin: 'LinkedIn', google: 'Google lead form', justdial: 'JustDial', indiamart: 'IndiaMART', tradeindia: 'TradeIndia' };
const SOURCE_WORD = { webhook: 'Webhook (any system)', whatsapp: 'WhatsApp chat (AI assistant)', email: 'Inbound email', chat: 'Website chat box', facebook: 'Facebook / Instagram lead ads', linkedin: 'LinkedIn lead-gen forms', google: 'Google Ads lead forms', justdial: 'JustDial (push)', indiamart: 'IndiaMART', tradeindia: 'TradeIndia' };
async function log(source, status, detail, { leadId = null, externalId = null } = {}) {
  await P.run('INSERT INTO "CrmCaptureLog" ("id", "source", "status", "detail", "leadId", "externalId", "at") VALUES (?, ?, ?, ?, ?, ?, ?)', P.newId('cap'), source, status, clip(detail, 500) || null, leadId, externalId ? clip(externalId, 120) : null, P.nowIso()).catch(() => null);
}
async function sourceLabel(source, given) {
  const st = await SETTINGS.load();
  const want = source === 'webhook' && given ? clip(given, 60) : SOURCE_NAME[source] || 'Other';
  const hit = st.sources.find((x) => x.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  if (source === 'webhook') return 'Other';
  await SETTINGS.save({ sources: [...st.sources.filter((x) => x !== 'Other'), want, 'Other'] }).catch(() => null); // the portal / ad source is added to the CRM's list once
  return want;
}
/** One lead from outside. data: { company, name, phone, email, city, state, designation, industry, notes, products, utm... }. */
async function createCaptured(source, data = {}, { externalId = null } = {}) {
  if (externalId && await P.one('SELECT "id" FROM "CrmCaptureLog" WHERE "source" = ? AND "externalId" = ? AND "status" IN (\'added\', \'note\')', source, clip(externalId, 120))) return { status: 200, body: { ok: true, duplicate: true, already: true } };
  const name = clip(data.name, 200);
  const company = clip(data.company, 200) || name || clip(data.email, 200);
  const phone = clip(data.phone, 40); const email = clip(data.email, 200).toLowerCase();
  if (!company) { await log(source, 'refused', 'no name or company', { externalId }); return S.fail(400, 'A name or a company is needed.'); }
  if (!phone && !email) { await log(source, 'refused', `${company}: no phone or email`, { externalId }); return S.fail(400, 'A phone number or an email is needed.'); }
  const label = await sourceLabel(source, data.source);
  const c = S.cleanFields('lead', { company, contactName: name, designation: data.designation, phone, email, industry: data.industry, city: data.city, source: label, notes: data.notes }, { partial: false });
  if (c.error) { await log(source, 'refused', `${company}: ${c.error}`, { externalId }); return S.fail(400, c.error); }
  const now = P.nowIso();
  const ph = S.phone10(phone);
  const same = (await P.all('SELECT "id", "phone", "email", "company" FROM "CrmLead"')).find((l) => (ph.length === 10 && S.phone10(l.phone) === ph) || (email && String(l.email || '').toLowerCase() === email));
  if (same) {
    await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Came in again from ${SOURCE_WORD[source] || label}`, note: [clip(data.notes, 1500), clip(data.products, 200)].filter(Boolean).join(' · ') || null, at: now, leadId: same.id, byName: SOURCE_WORD[source] || label, createdAt: now });
    await log(source, 'note', `${company}: added as a note on ${same.company}`, { leadId: same.id, externalId });
    return S.okBody({ ok: true, duplicate: true, id: same.id });
  }
  const st = await SETTINGS.load();
  const row = { id: S.newId('lead'), ...c.data, source: label, status: 'New', stage: st.leadStages[0].name, utmSource: clip(data.utmSource, 120) || null, utmMedium: clip(data.utmMedium, 120) || null, utmCampaign: clip(data.utmCampaign, 120) || null, pageUrl: clip(data.pageUrl, 500) || null, createdById: null, createdAt: now, updatedAt: now };
  // who gets it: the lead rules, else the website form's round robin when that is on, else nobody yet (a Sales manager gives it)
  let own = await ownerFor({ ...row, state: data.state }, { extra: { products: data.products } }).catch(() => null);
  if (!own) { const SALES = require('../sales'); const w = await SALES.websiteGet({ role: 'SUPER_ADMIN', id: 'system' }).catch(() => null); if (w && w.body && w.body.autoAssign) own = await SALES.takeTurn().catch(() => null); } // eslint-disable-line global-require
  row.ownerId = own ? own.id : null; row.ownerName = own ? own.name : null;
  const [code] = await S.nextCodes('lead', 1).catch(() => []);
  if (code) row.code = code;
  const saved = await S.insert('CrmLead', row);
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Lead from ${SOURCE_WORD[source] || label}`, note: [clip(data.notes, 1500), data.products ? `Interested in: ${clip(data.products, 200)}` : '', own && own.rule ? `Given to ${own.name} by the rule "${own.rule}"` : ''].filter(Boolean).join('\n') || null, at: now, leadId: saved.id, byName: SOURCE_WORD[source] || label, createdAt: now });
  if (own) {
    const prisma = require('../../db'); // eslint-disable-line global-require
    await prisma.notification.create({ data: { userId: own.id, title: `New lead from ${label}: ${saved.company}`, message: `Open: /crm/leads?open=lead:${saved.id}`, channel: 'In-App', recipient: `crm-cap|${saved.id}`, status: 'Sent' } }).catch(() => {});
    await require('../sales').firstFollowUp(saved).catch(() => null); // eslint-disable-line global-require
  }
  await log(source, 'added', `${saved.company}${own ? ` -> ${own.name}` : ''}`, { leadId: saved.id, externalId });
  return S.okBody({ ok: true, id: saved.id, owner: own ? own.name : null });
}

// ---- the capture settings ------------------------------------------------------------------------------------------------------
const newKey = () => `tlcap_${crypto.randomBytes(24).toString('base64url')}`;
async function captureKey() {
  const cfg = await P.config({ fresh: true });
  if (cfg.capture.key) return cfg.capture.key;
  const key = newKey();
  await P.saveConfig({ capture: { ...cfg.capture, key } });
  return key;
}
function sameKey(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function integration(id) {
  const ic = await require('../../utils/integrationStore').readConfig(id).catch(() => null); // eslint-disable-line global-require
  return (ic && ic.values) || {};
}
async function captureGet(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead capture is set up by a Sales manager or an Admin.');
  const key = await captureKey();
  const cfg = await P.config({ fresh: true });
  const meta = await integration('crm-lead-ads'); const portals = await integration('crm-india-portals');
  const ready = {
    facebook: !!(meta['Page access token'] && meta['App secret'] && meta['Verify token']),
    indiamart: !!portals['IndiaMART CRM key'],
    tradeindia: !!(portals['TradeIndia user ID'] && portals['TradeIndia profile ID'] && portals['TradeIndia key']),
  };
  const recent = await P.all('SELECT * FROM "CrmCaptureLog" ORDER BY "at" DESC LIMIT 30');
  const counts = await P.all('SELECT "source", COUNT(*) AS "n" FROM "CrmCaptureLog" WHERE "status" = \'added\' AND "at" >= ? GROUP BY "source"', new Date(Date.now() - 30 * 86400000).toISOString());
  return S.okBody({ key, on: cfg.capture.on, pull: cfg.capture.pull, pullMinutes: cfg.capture.pullMinutes, lastPull: cfg.capture.lastPull, ready, words: SOURCE_WORD, recent, counts: Object.fromEntries(counts.map((c) => [c.source, Number(c.n)])) });
}
async function captureSave(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead capture is set up by a Sales manager or an Admin.');
  const cfg = await P.config({ fresh: true });
  const on = { ...cfg.capture.on }; const pull = { ...cfg.capture.pull };
  Object.keys(body.on || {}).forEach((k) => { if (k in SOURCE_WORD) on[k] = body.on[k] === true; });
  Object.keys(body.pull || {}).forEach((k) => { if (['indiamart', 'tradeindia'].includes(k)) pull[k] = body.pull[k] === true; });
  await P.saveConfig({ capture: { ...cfg.capture, on, pull, pullMinutes: body.pullMinutes || cfg.capture.pullMinutes } });
  for (const k of [...Object.keys(on).filter((x) => on[x]), ...Object.keys(pull).filter((x) => pull[x])]) await sourceLabel(k); // eslint-disable-line no-await-in-loop
  await S.audit(user, 'CRM lead capture changed', 'AppSetting', 'crm.plus', `on: ${[...Object.keys(on).filter((x) => on[x]), ...Object.keys(pull).filter((x) => pull[x])].join(', ') || 'nothing'}`);
  return captureGet(user);
}
async function captureNewKey(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead capture is set up by a Sales manager or an Admin.');
  const cfg = await P.config({ fresh: true });
  await P.saveConfig({ capture: { ...cfg.capture, key: newKey() } });
  await S.audit(user, 'CRM lead capture key changed', 'AppSetting', 'crm.plus', 'The old key stopped working');
  return captureGet(user);
}

// ---- each source's shape -> one lead ------------------------------------------------------------------------------------------------
const FREE_MAIL = /^(gmail|yahoo|ymail|hotmail|outlook|live|rediffmail|icloud|aol|protonmail|zoho)\./i;
const phoneIn = (t) => { const m = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/.exec(String(t || '')); return m ? m[0] : ''; };
function fromEmail(b) {
  const from = clip(b.from || b.sender || b.From || (b.envelope && (() => { try { return JSON.parse(b.envelope).from; } catch { return ''; } })()), 300);
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  const email = (m ? m[2] : from).trim().toLowerCase();
  const name = m ? m[1].trim() : '';
  const subject = clip(b.subject || b.Subject, 200);
  const text = clip(b.text || b['body-plain'] || b['stripped-text'] || b.body || b.html, 3000).replace(/<[^>]+>/g, ' ');
  const domain = email.includes('@') ? email.split('@')[1] : '';
  const company = domain && !FREE_MAIL.test(domain) ? domain.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) : '';
  return { name: name || email.split('@')[0], company: company || name || email, email, phone: phoneIn(text), notes: [subject && `Subject: ${subject}`, text].filter(Boolean).join('\n') };
}
function fromGoogle(b) {
  const cols = {};
  (Array.isArray(b.user_column_data) ? b.user_column_data : []).forEach((c) => { cols[String(c.column_id || c.column_name || '').toUpperCase()] = c.string_value; });
  return { name: cols.FULL_NAME || [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' '), email: cols.EMAIL || cols.WORK_EMAIL, phone: cols.PHONE_NUMBER || cols.WORK_PHONE, company: cols.COMPANY_NAME, designation: cols.JOB_TITLE, city: cols.CITY, state: cols.REGION, utmCampaign: clip(b.campaign_id, 120), notes: [b.form_id && `Google form ${b.form_id}`, cols.QUESTION || ''].filter(Boolean).join(' · ') };
}
function fromLinkedIn(b) {
  const a = b.answers || b;
  return { name: clip(a.name || [a.firstName || a.first_name, a.lastName || a.last_name].filter(Boolean).join(' '), 200), email: a.emailAddress || a.email, phone: a.phoneNumber || a.phone, company: a.companyName || a.company, designation: a.jobTitle || a.title, city: a.city, notes: [b.formName || b.form_name, b.campaignName || b.campaign_name].filter(Boolean).join(' · '), utmCampaign: b.campaignName || b.campaign_name };
}
function fromJustDial(b) {
  return { name: [b.prefix, b.name].filter(Boolean).join(' '), phone: b.mobile || b.phone, email: b.email, company: b.company, city: b.city, state: b.state, products: b.category, notes: [b.category && `Looking for: ${b.category}`, b.area, b.pincode].filter(Boolean).join(' · ') };
}
function fromIndiaMart(x) {
  return { externalId: x.UNIQUE_QUERY_ID || x.QUERY_ID, data: { name: x.SENDER_NAME, phone: x.SENDER_MOBILE || x.SENDER_PHONE, email: x.SENDER_EMAIL, company: x.SENDER_COMPANY, city: x.SENDER_CITY, state: x.SENDER_STATE, products: x.QUERY_PRODUCT_NAME, notes: [x.QUERY_PRODUCT_NAME && `Product: ${x.QUERY_PRODUCT_NAME}`, x.SUBJECT, clip(x.QUERY_MESSAGE, 1500)].filter(Boolean).join('\n') } };
}
function fromTradeIndia(x) {
  return { externalId: x.rfi_id || x.inquiry_id, data: { name: x.sender_name, phone: x.sender_mobile || x.sender_phone, email: x.sender_email, company: x.sender_co || x.sender_company, city: x.sender_city, state: x.sender_state, products: x.product_name, notes: [x.product_name && `Product: ${x.product_name}`, x.subject, clip(x.message, 1500)].filter(Boolean).join('\n') } };
}
function fromFbFields(fieldData = []) {
  const f = {};
  fieldData.forEach((x) => { f[String(x.name || '').toLowerCase()] = Array.isArray(x.values) ? x.values[0] : x.values; });
  return { name: f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' '), email: f.email || f.work_email, phone: f.phone_number || f.phone, company: f.company_name || f.company, designation: f.job_title, city: f.city, state: f.state, notes: Object.entries(f).filter(([k]) => !['full_name', 'first_name', 'last_name', 'email', 'work_email', 'phone_number', 'phone', 'company_name', 'company', 'job_title', 'city', 'state'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n') };
}

/** POST /api/crm/capture/:source (everything but Facebook). -> { status, body } */
async function inbound(source, body = {}, key = '') {
  if (!SOURCE_WORD[source] || source === 'facebook' || source === 'tradeindia') return S.fail(404, 'Unknown lead source.');
  const cfg = await P.config();
  const k = key || body.api_key || body.apiKey || body.google_key || body.key;
  if (!cfg.capture.key || !sameKey(k, cfg.capture.key)) { await log(source, 'refused', 'wrong key'); return S.fail(401, 'The capture key is not right.'); }
  if (source === 'indiamart') { if (!cfg.capture.pull.indiamart && !cfg.capture.on.indiamart) return S.fail(403, 'IndiaMART leads are switched off in the CRM.'); } else if (!cfg.capture.on[source]) { await log(source, 'refused', 'source switched off'); return S.fail(403, 'This lead source is switched off in the CRM (CRM settings > Customise > Lead capture).'); }
  if (clip(body.website_url, 200)) return S.okBody({ ok: true }); // the chat box honeypot
  if (source === 'email') return createCaptured('email', fromEmail(body), { externalId: body['Message-Id'] || body['message-id'] || null });
  if (source === 'google') return createCaptured('google', fromGoogle(body), { externalId: body.lead_id || null });
  if (source === 'linkedin') return createCaptured('linkedin', fromLinkedIn(body), { externalId: body.leadId || body.lead_id || null });
  if (source === 'justdial') return createCaptured('justdial', fromJustDial(body), { externalId: body.leadid || null });
  if (source === 'indiamart') {
    const list = Array.isArray(body.RESPONSE) ? body.RESPONSE : body.RESPONSE ? [body.RESPONSE] : [body];
    let last = null;
    for (const x of list) { const m = fromIndiaMart(x); last = await createCaptured('indiamart', m.data, { externalId: m.externalId }); } // eslint-disable-line no-await-in-loop
    return last || S.fail(400, 'Nothing in the push.');
  }
  // chat box and the plain webhook: { name, company, phone, email, message, city, source, utm_* }
  return createCaptured(source, { name: body.name, company: body.company, phone: body.phone || body.mobile, email: body.email, city: body.city, state: body.state, designation: body.designation, industry: body.industry, products: body.products || body.product, source: body.source, notes: clip(body.message || body.notes, 2000), utmSource: body.utm_source, utmMedium: body.utm_medium, utmCampaign: body.utm_campaign, pageUrl: body.page_url }, { externalId: body.id || body.external_id || null });
}

// ---- Facebook / Instagram lead ads (Meta webhook) -------------------------------------------------------------------------------------
async function facebookVerify(q = {}) {
  const meta = await integration('crm-lead-ads');
  if (q['hub.mode'] === 'subscribe' && meta['Verify token'] && sameKey(q['hub.verify_token'], meta['Verify token'])) return { status: 200, text: String(q['hub.challenge'] || '') };
  return { status: 403, text: 'forbidden' };
}
async function facebookLead(rawBody, signature, parsed) {
  const meta = await integration('crm-lead-ads');
  const secret = meta['App secret'];
  if (!secret) return S.fail(409, 'Facebook lead ads are not connected (Administration > Integrations > CRM lead ads).');
  const want = `sha256=${crypto.createHmac('sha256', secret).update(rawBody || Buffer.alloc(0)).digest('hex')}`;
  if (!sameKey(signature, want)) { await log('facebook', 'refused', 'bad signature'); return S.fail(401, 'Bad signature.'); }
  const cfg = await P.config();
  if (!cfg.capture.on.facebook) { await log('facebook', 'refused', 'source switched off'); return S.okBody({ ok: true, off: true }); } // Meta wants a 200, or it retries for days
  const changes = (parsed.entry || []).flatMap((e) => (e.changes || []).filter((c) => c.field === 'leadgen').map((c) => c.value || {}));
  let added = 0;
  for (const v of changes) {
    let fields = v.field_data; // a test / Zapier relay may carry the answers already
    if (!fields && v.leadgen_id) {
      if (testServer()) { await log('facebook', 'refused', `test server: would read lead ${v.leadgen_id} from the Graph API`, { externalId: v.leadgen_id }); continue; } // eslint-disable-line no-continue, no-await-in-loop
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(v.leadgen_id)}?access_token=${encodeURIComponent(meta['Page access token'])}`);
        const j = await res.json(); // eslint-disable-line no-await-in-loop
        if (!res.ok) { await log('facebook', 'failed', `Graph API: ${(j.error && j.error.message) || res.status}`, { externalId: v.leadgen_id }); continue; } // eslint-disable-line no-await-in-loop, no-continue
        fields = j.field_data;
      } catch (e) { await log('facebook', 'failed', `Graph API: ${e.message}`, { externalId: v.leadgen_id }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    }
    const out = await createCaptured('facebook', { ...fromFbFields(fields || []), utmCampaign: v.ad_id || v.adgroup_id || null }, { externalId: v.leadgen_id }); // eslint-disable-line no-await-in-loop
    if (out.status === 200) added += 1;
  }
  return S.okBody({ ok: true, added });
}

// ---- India portals: pull --------------------------------------------------------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imTime = (ms) => { const d = new Date(ms + 5.5 * 3600000); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
const STUB = {
  indiamart: { CODE: 200, STATUS: 'SUCCESS', TOTAL_RECORDS: 1, RESPONSE: [{ UNIQUE_QUERY_ID: 'IM-TEST-1', SENDER_NAME: 'Portal Buyer One', SENDER_MOBILE: '+91-9811100001', SENDER_EMAIL: 'buyer.one@portal-example.in', SENDER_COMPANY: 'Portal Buyer Traders', SENDER_CITY: 'Pune', SENDER_STATE: 'Maharashtra', QUERY_PRODUCT_NAME: 'HRMS software', QUERY_MESSAGE: 'Need HRMS for 80 staff' }] },
  tradeindia: [{ rfi_id: 'TI-TEST-1', sender_name: 'Trade Buyer Two', sender_mobile: '9811100002', sender_email: 'buyer.two@trade-example.in', sender_co: 'Trade Buyer Exports', sender_city: 'Surat', sender_state: 'Gujarat', product_name: 'Recruitment services', subject: 'Requirement', message: 'Need 10 sales staff' }],
};
async function pull(source, { now = Date.now(), force = false } = {}) {
  const cfg = await P.config({ fresh: true });
  if (!force && !cfg.capture.pull[source]) return { off: true };
  const last = cfg.capture.lastPull[source] ? Date.parse(cfg.capture.lastPull[source]) : now - 24 * 3600000;
  if (!force && now - last < cfg.capture.pullMinutes * 60000) return { notYet: true };
  const v = await integration('crm-india-portals');
  let list = [];
  if (source === 'indiamart') {
    if (!v['IndiaMART CRM key']) return { notConfigured: true };
    let j;
    if (testServer()) j = STUB.indiamart;
    else {
      const from = Math.max(last - 5 * 60000, now - 6.9 * 86400000); // the API looks back at most 7 days
      const res = await fetch(`https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(v['IndiaMART CRM key'])}&start_time=${encodeURIComponent(imTime(from))}&end_time=${encodeURIComponent(imTime(now))}`);
      j = await res.json().catch(() => ({}));
    }
    if (Number(j.CODE) !== 200 && !(j.STATUS === 'SUCCESS')) { await log('indiamart', 'failed', `IndiaMART: ${j.MESSAGE || j.STATUS || 'no answer'}`); return { error: j.MESSAGE || 'IndiaMART did not answer' }; }
    list = (j.RESPONSE || []).map(fromIndiaMart);
  } else if (source === 'tradeindia') {
    if (!(v['TradeIndia user ID'] && v['TradeIndia profile ID'] && v['TradeIndia key'])) return { notConfigured: true };
    let j;
    if (testServer()) j = STUB.tradeindia;
    else {
      const ymd = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
      const res = await fetch(`https://www.tradeindia.com/utils/my_inquiry.html?userid=${encodeURIComponent(v['TradeIndia user ID'])}&profile_id=${encodeURIComponent(v['TradeIndia profile ID'])}&key=${encodeURIComponent(v['TradeIndia key'])}&from_date=${ymd(last)}&to_date=${ymd(now)}`);
      j = await res.json().catch(() => []);
    }
    list = (Array.isArray(j) ? j : []).map(fromTradeIndia);
  } else return { error: 'unknown source' };
  let added = 0; let notes = 0;
  for (const m of list) {
    const out = await createCaptured(source, m.data, { externalId: m.externalId }); // eslint-disable-line no-await-in-loop
    if (out.status === 200 && !out.body.duplicate) added += 1; else if (out.status === 200 && !out.body.already) notes += 1;
  }
  const fresh = await P.config({ fresh: true });
  await P.saveConfig({ capture: { ...fresh.capture, lastPull: { ...fresh.capture.lastPull, [source]: new Date(now).toISOString() } } });
  return { ok: true, fetched: list.length, added, notes };
}
async function pullNow(user, source) {
  if (!mayAdmin(user)) return S.fail(403, 'Lead capture is set up by a Sales manager or an Admin.');
  if (!['indiamart', 'tradeindia'].includes(source)) return S.fail(404, 'Unknown portal.');
  const out = await pull(source, { force: true });
  if (out.notConfigured) return S.fail(409, `${SOURCE_WORD[source]} is not connected: save its key in Administration > Integrations > CRM India portals.`, { notConfigured: true });
  if (out.error) return S.fail(502, `${SOURCE_WORD[source]}: ${out.error}`);
  await S.audit(user, `CRM ${SOURCE_WORD[source]} leads pulled`, 'CrmCaptureLog', source, `${out.fetched} read, ${out.added} new`);
  return S.okBody(out);
}
async function tick() {
  for (const s of ['indiamart', 'tradeindia']) await pull(s).catch((e) => console.error(`[crm] ${s} pull:`, e.message)); // eslint-disable-line no-await-in-loop, no-console
}

// the chat box for the company website (a snippet the Admin pastes; posts to the chat door with the capture key)
function chatSnippet(base, key) {
  const url = `${String(base || '').replace(/\/+$/, '')}/api/crm/capture/chat?key=${encodeURIComponent(key)}`;
  return [
    '<div id="tl-chat" style="position:fixed;right:18px;bottom:18px;z-index:9999;font-family:sans-serif">',
    '  <button id="tl-chat-btn" style="background:#1b2a4a;color:#fff;border:0;border-radius:24px;padding:12px 18px;cursor:pointer">💬 Chat with us</button>',
    '  <form id="tl-chat-form" style="display:none;background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px;width:260px;box-shadow:0 6px 24px rgba(0,0,0,.15)">',
    '    <input name="name" placeholder="Your name" required style="width:100%;margin-bottom:6px"><input name="phone" placeholder="Mobile" style="width:100%;margin-bottom:6px">',
    '    <input name="email" placeholder="Email" style="width:100%;margin-bottom:6px"><textarea name="message" placeholder="How can we help?" style="width:100%;margin-bottom:6px"></textarea>',
    '    <input name="website_url" style="display:none" tabindex="-1" autocomplete="off"><button type="submit">Send</button>',
    '  </form>',
    '</div>',
    '<script>',
    "document.getElementById('tl-chat-btn').onclick=function(){var f=document.getElementById('tl-chat-form');f.style.display=f.style.display==='none'?'block':'none';};",
    "document.getElementById('tl-chat-form').onsubmit=function(e){e.preventDefault();var f=e.target;var d=Object.fromEntries(new FormData(f));d.page_url=location.href;",
    `fetch('${url}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){if(!r.ok)throw 0;f.reset();f.innerHTML='Thank you! We will reply soon.';}).catch(function(){alert('Sorry, this could not be sent.');});};`,
    '</script>',
  ].join('\n');
}

module.exports = { ownerFor, rulesList, ruleSave, ruleRemove, rulesSwitch, ruleTest, createCaptured, inbound, facebookVerify, facebookLead, captureGet, captureSave, captureNewKey, pull, pullNow, tick, chatSnippet, SOURCE_WORD, RULE_FIELDS };
