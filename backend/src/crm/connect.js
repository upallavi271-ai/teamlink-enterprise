// ---------------------------------------------------------------------------
// CRM WAVE A - THE CRM TALKS TO OTHER SYSTEMS (2026-11-24):
//   * OUTBOUND WEBHOOKS (08.07, 15.03): CRM events (lead.created, deal.won ...) POSTed to the addresses listed in CRM > Dashboard >
//     Automation > Webhooks. Signed: X-TeamLink-Signature = "sha256=" + HMAC-SHA256 of the raw body with that address's own secret
//     (kept encrypted, utils/secrets.js). Public addresses only (utils/safeFetch.js). A failure is retried after 1, 5 and 15 minutes.
//     Zapier / Make / n8n subscribe themselves through the CRM API (REST hooks, routes/crmApi.js) and land in the same list.
//     Phone and email go only to an address that was set to include them.
//   * SLACK / MICROSOFT TEAMS (15.09): the chosen events as one line in a channel, through each tool's incoming-webhook URL, which is
//     kept in Administration > Integrations (Slack / Microsoft Teams, encrypted).
//   * CRM API KEYS (15.01): a key acts as the CRM person it belongs to (their scope, their rights; read or read + write). Only its
//     SHA-256 is kept; it is shown once. Optional list of addresses it may be used from.
//   * The apps catalogue (15.08), the private calendar feed of a person's follow-ups (15.04 / 15.05: Google Calendar / Outlook subscribe to
//     it) and contacts as a vCard file (Google Contacts / Outlook import it).
// Nothing here reaches outside until an Admin turns it on (crm.wave switches, crm/waveSchema.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const W = require('./waveSchema');
const S = require('./service');
const DB = require('./schema');
const { fetchPublic } = require('../utils/safeFetch');

const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isAdmin = (user) => S.roleOf(user) === 'admin';
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));

const EVENTS = [
  ['lead.created', 'A lead was added'], ['lead.updated', 'A lead was changed'], ['lead.stage_changed', 'A lead moved to another stage'], ['lead.converted', 'A lead was converted'],
  ['deal.created', 'A deal was added'], ['deal.updated', 'A deal was changed'], ['deal.stage_changed', 'A deal moved to another stage'], ['deal.won', 'A deal was won'], ['deal.lost', 'A deal was lost'],
  ['account.created', 'A customer / account was added'], ['account.updated', 'A customer / account was changed'], ['contact.created', 'A contact was added'],
  ['activity.logged', 'A call, meeting, email or note was logged'], ['task.done', 'A follow-up was done'],
  ['invoice.created', 'An invoice was raised'], ['invoice.paid', 'An invoice was paid in full'],
  ['approval.requested', 'An approval is waiting'], ['approval.decided', 'An approval was decided'], ['rule.fired', 'A rule sent a webhook'],
];
const EVENT_NAMES = EVENTS.map((e) => e[0]);

// ---- what an outside system is told about a record --------------------------------------------------------------------------------
const PICK = {
  lead: ['id', 'code', 'company', 'contactName', 'designation', 'source', 'status', 'stage', 'rating', 'industry', 'city', 'expectedValue', 'ownerId', 'ownerName', 'createdAt', 'updatedAt'],
  deal: ['id', 'code', 'title', 'accountId', 'contactId', 'leadId', 'stage', 'value', 'finalValue', 'discountPercent', 'probability', 'expectedClose', 'nextStep', 'wonAt', 'lostAt', 'lostReason', 'approvalStatus', 'ownerId', 'ownerName', 'createdAt', 'updatedAt'],
  account: ['id', 'code', 'name', 'kind', 'industry', 'city', 'state', 'source', 'website', 'ownerId', 'ownerName', 'createdAt', 'updatedAt'],
  contact: ['id', 'accountId', 'name', 'designation', 'role', 'ownerName', 'createdAt'],
  task: ['id', 'title', 'type', 'priority', 'status', 'dueDate', 'dueTime', 'outcome', 'leadId', 'dealId', 'accountId', 'ownerId', 'ownerName', 'doneAt'],
  activity: ['id', 'kind', 'subject', 'at', 'leadId', 'dealId', 'accountId', 'contactId', 'byName'],
  invoice: ['id', 'code', 'dealId', 'accountId', 'accountName', 'title', 'status', 'issueDate', 'dueDate', 'amount', 'taxAmount', 'total', 'paidAmount', 'paidAt', 'ownerName'],
  approval: ['id', 'kind', 'entityId', 'entityName', 'title', 'status', 'step', 'ruleName', 'createdAt', 'decidedAt'],
};
const CONTACT_FIELDS = { lead: ['phone', 'email'], account: ['phone', 'email'], contact: ['phone', 'email'] };
function shape(kind, row, { contact = false } = {}) {
  if (!row) return null;
  const out = {};
  for (const k of PICK[kind] || Object.keys(row)) if (row[k] !== undefined) out[k] = row[k];
  if (contact) for (const k of CONTACT_FIELDS[kind] || []) out[k] = row[k] == null ? null : row[k];
  return out;
}
const nameOf = (kind, row) => (row ? (row.company || row.title || row.name || row.subject || row.code || row.id) : '');

// ---- webhooks: the list --------------------------------------------------------------------------------------------------------------
const cleanEvents = (v) => {
  const list = (Array.isArray(v) ? v : String(v || '*').split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return '*';
  const bad = list.filter((e) => !EVENT_NAMES.includes(e));
  if (bad.length) return { error: `Unknown event: ${bad.join(', ')}. Pick from the list.` };
  return list.join(',');
};
async function checkUrl(raw) {
  const url = String(raw || '').trim().slice(0, 500);
  let u;
  try { u = new URL(url); } catch { return { error: 'Type the full address, starting with https://' }; }
  const localOk = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PRIVATE_FETCH || ''));
  if (u.protocol !== 'https:' && !(localOk && u.protocol === 'http:')) return { error: 'The address must start with https://' };
  return { url };
}
const hookOut = (h) => ({ id: h.id, url: h.url, label: h.label, events: h.events === '*' ? ['*'] : String(h.events || '').split(',').filter(Boolean), on: !!h.on, includeContact: !!h.includeContact, source: h.source || 'manual', createdByName: h.createdByName, createdAt: h.createdAt, lastStatus: h.lastStatus, lastAt: h.lastAt, fails: h.fails || 0, hasSecret: !!h.secret });
function encrypt(plain) {
  const SEC = require('../utils/secrets'); // eslint-disable-line global-require
  return SEC.encryptSecret(plain);
}
function decrypt(stored) {
  if (!stored) return '';
  const SEC = require('../utils/secrets'); // eslint-disable-line global-require
  return SEC.isEncrypted(stored) ? (SEC.decryptSecret(stored) || '') : String(stored);
}

async function listHooks(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the webhooks.');
  const rows = await W.all('SELECT * FROM "CrmWebhook" ORDER BY "createdAt" DESC');
  const log = await W.all('SELECT * FROM "CrmWebhookLog" ORDER BY "at" DESC LIMIT 60');
  const sw = await W.switches();
  return S.okBody({ on: sw.webhooksOn, hooks: rows.map(hookOut), log, events: EVENTS.map(([name, label]) => ({ name, label })) });
}
// add one (by a person in the CRM screen, or by Zapier / Make / n8n through the API: source)
async function addHook(user, body = {}, { source = 'manual' } = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin adds webhooks.');
  const u = await checkUrl(body.url);
  if (u.error) return S.fail(400, u.error);
  const ev = cleanEvents(body.events != null ? body.events : body.event);
  if (ev && ev.error) return S.fail(400, ev.error);
  const n = await W.one('SELECT COUNT(*) AS "n" FROM "CrmWebhook"');
  if (Number(n && n.n) >= 50) return S.fail(400, 'There are 50 webhooks already. Remove one first.');
  const secret = `whsec_${crypto.randomBytes(18).toString('base64url')}`;
  let stored;
  try { stored = encrypt(secret); } catch (e) { return S.fail(400, e.code === 'NO_SECRET_KEY' ? 'The server has no secrets key yet (INTEGRATION_SECRET_KEY). Ask the developer to set it.' : 'The signing secret could not be kept.'); }
  const row = await W.insert('CrmWebhook', {
    id: newId('hook'), url: u.url, secret: stored, events: ev, on: body.on === false ? 0 : 1, includeContact: body.includeContact === true ? 1 : 0,
    source: ['manual', 'zapier', 'make', 'n8n', 'api'].includes(source) ? source : 'manual', label: S.clip(body.label, 80), createdById: user.id, createdByName: user.name || null, createdAt: now(),
  });
  await S.audit(user, 'CRM webhook added', 'CrmWebhook', row.id, `${u.url} · ${ev}${row.includeContact ? ' · with phone and email' : ''}`);
  return S.okBody({ ok: true, hook: hookOut(row), secret, note: 'Copy the signing secret now: it is shown only once. Check X-TeamLink-Signature with it.' });
}
async function editHook(user, id, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin changes webhooks.');
  const row = await W.one('SELECT * FROM "CrmWebhook" WHERE "id" = ?', String(id || ''));
  if (!row) return S.fail(404, 'This webhook is not there.');
  const data = {};
  if ('on' in body) data.on = body.on ? 1 : 0;
  if ('includeContact' in body) data.includeContact = body.includeContact ? 1 : 0;
  if ('events' in body) { const ev = cleanEvents(body.events); if (ev && ev.error) return S.fail(400, ev.error); data.events = ev; }
  if ('label' in body) data.label = S.clip(body.label, 80);
  if (data.on === 1) data.fails = 0;
  const saved = await W.update('CrmWebhook', row.id, data);
  await S.audit(user, 'CRM webhook changed', 'CrmWebhook', row.id, JSON.stringify(data).slice(0, 200));
  return S.okBody({ ok: true, hook: hookOut(saved) });
}
async function removeHook(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin removes webhooks.');
  const row = await W.one('SELECT * FROM "CrmWebhook" WHERE "id" = ?', String(id || ''));
  if (!row) return S.fail(404, 'This webhook is not there.');
  await W.run('DELETE FROM "CrmWebhook" WHERE "id" = ?', row.id);
  await S.audit(user, 'CRM webhook removed', 'CrmWebhook', row.id, row.url);
  return S.okBody({ ok: true });
}

// ---- delivery ------------------------------------------------------------------------------------------------------------------------
const RETRY_MIN = [1, 5, 15];
async function logDelivery(hookId, target, event, r, attempt) {
  await W.insert('CrmWebhookLog', { id: newId('whl'), hookId: hookId || null, target: String(target || '').slice(0, 200), event, ok: r.ok ? 1 : 0, code: r.status || null, error: r.error ? String(r.error).slice(0, 200) : null, attempt, at: now() }).catch(() => {});
  // keep the log small: the last 500 lines
  await W.run('DELETE FROM "CrmWebhookLog" WHERE "id" IN (SELECT "id" FROM "CrmWebhookLog" ORDER BY "at" DESC LIMIT -1 OFFSET 500)').catch(() => {});
}
async function post(url, body, { secret, event, headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const sig = secret ? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` : '';
  let status = 0; let error = '';
  try {
    const res = await fetchPublic(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'TeamLink-CRM-Webhooks/1', ...(event ? { 'x-teamlink-event': event } : {}), ...(body.id ? { 'x-teamlink-delivery': body.id } : {}), ...(sig ? { 'x-teamlink-signature': sig } : {}), ...headers },
      body: raw,
      signal: AbortSignal.timeout(10000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String((err && /^SSRF_/.test(err.code || '') ? err.message : (err && err.name === 'TimeoutError' ? 'timed out after 10 s' : (err && err.message) || err))).slice(0, 200);
  }
  return { ok: status >= 200 && status < 300, status, error };
}
async function deliverTo(hook, body, event, attempt = 1) {
  const r = await post(hook.url, body, { secret: decrypt(hook.secret), event });
  await logDelivery(hook.id, hook.url, event, r, attempt);
  const fails = r.ok ? 0 : (Number(hook.fails) || 0) + 1;
  // ten failures in a row turn the address off (it is shown as "Turned off after failures")
  await W.update('CrmWebhook', hook.id, { lastStatus: r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error}`, lastAt: now(), fails, ...(fails >= 10 ? { on: 0 } : {}) }).catch(() => {});
  const retryable = !r.ok && (r.status === 0 || r.status === 429 || r.status >= 500);
  if (retryable && attempt <= RETRY_MIN.length && !process.env.TEST_MODE) {
    const t = setTimeout(() => { deliverTo({ ...hook, fails }, body, event, attempt + 1).catch(() => {}); }, RETRY_MIN[attempt - 1] * 60000);
    if (t.unref) t.unref();
  }
  return r;
}
const wantsEvent = (h, event) => h.events === '*' || String(h.events || '').split(',').includes(event);
// one CRM event to every address that wants it (called by crm/events.js; never throws)
async function deliverEvent(event, { kind, record, before, via } = {}) {
  const sw = await W.switches();
  if (!sw.webhooksOn) return 0;
  const hooks = (await W.all('SELECT * FROM "CrmWebhook" WHERE "on" = 1')).filter((h) => wantsEvent(h, event));
  let n = 0;
  for (const h of hooks) {
    const data = { kind, record: shape(kind, record, { contact: !!h.includeContact }), ...(before ? { before: shape(kind, before, { contact: !!h.includeContact }) } : {}), ...(via ? { via } : {}) };
    // eslint-disable-next-line no-await-in-loop
    await deliverTo(h, { id: crypto.randomUUID(), event, at: now(), data }, event).catch(() => null);
    n += 1;
  }
  return n;
}
async function testHook(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin tests webhooks.');
  const h = await W.one('SELECT * FROM "CrmWebhook" WHERE "id" = ?', String(id || ''));
  if (!h) return S.fail(404, 'This webhook is not there.');
  const r = await post(h.url, { id: crypto.randomUUID(), event: 'ping', at: now(), data: { message: 'TeamLink CRM webhook test' } }, { secret: decrypt(h.secret), event: 'ping' });
  await logDelivery(h.id, h.url, 'ping', r, 1);
  return S.okBody({ ok: r.ok, message: r.ok ? `Delivered (HTTP ${r.status}).` : `Failed: ${r.error}` });
}

// ---- Slack / Microsoft Teams ------------------------------------------------------------------------------------------------------
const CHAT = { slack: { channel: 'slack', label: 'Slack' }, teams: { channel: 'teams', label: 'Microsoft Teams' } };
const URL_LABEL = 'Incoming webhook URL (secret)';
async function chatUrl(tool) {
  const { readConfig } = require('../utils/integrationStore'); // eslint-disable-line global-require
  const c = await readConfig(CHAT[tool].channel).catch(() => ({ values: {} }));
  return String((c.values || {})[URL_LABEL] || '').trim();
}
const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
function chatText(event, kind, rec, before) {
  const r = rec || {};
  const who = r.ownerName ? ` (${r.ownerName})` : '';
  switch (event) {
    case 'lead.created': return `New lead: ${r.company || '-'}${r.source ? ` from ${r.source}` : ''}${who}`;
    case 'lead.converted': return `Lead converted: ${r.company || '-'}${who}`;
    case 'lead.stage_changed': return `Lead ${r.company || '-'}: ${before ? `${before.stage || '-'} → ` : ''}${r.stage || '-'}${who}`;
    case 'deal.created': return `New deal: ${r.title || '-'} · ${rupees(r.value)}${who}`;
    case 'deal.won': return `Deal won: ${r.title || '-'} · ${rupees(r.finalValue || r.value)}${who}`;
    case 'deal.lost': return `Deal lost: ${r.title || '-'}${r.lostReason ? ` · ${r.lostReason}` : ''}${who}`;
    case 'deal.stage_changed': return `Deal ${r.title || '-'}: ${before ? `${before.stage} → ` : ''}${r.stage}${who}`;
    case 'invoice.created': return `Invoice ${r.code || ''} raised: ${r.accountName || '-'} · ${rupees(r.total)}`;
    case 'invoice.paid': return `Invoice ${r.code || ''} paid in full: ${r.accountName || '-'} · ${rupees(r.total)}`;
    case 'task.done': return `Follow-up done: ${r.title || '-'}${r.outcome ? ` · ${r.outcome}` : ''}${who}`;
    case 'approval.requested': return `Approval waiting: ${r.title || '-'}`;
    case 'approval.decided': return `Approval ${String(r.status || '').toLowerCase()}: ${r.title || '-'}`;
    default: return `${event}: ${nameOf(kind, r)}`;
  }
}
function chatBody(tool, text, link) {
  if (tool === 'slack') return { text: link ? `${text} <${link}|Open in TeamLink>` : text };
  // Teams: the classic connector reads "text"; a Workflows webhook reads the Adaptive Card
  return {
    type: 'message', text: link ? `${text} [Open in TeamLink](${link})` : text,
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }], ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in TeamLink', url: link }] } : {}) } }],
  };
}
const linkFor = (kind, rec) => {
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const page = { lead: 'leads', deal: 'deals', account: 'accounts' }[kind];
  return base && page && rec && rec.id ? `${base}/crm/${page}?open=${kind}:${rec.id}` : '';
};
async function postChat(tool, text, link) {
  const url = await chatUrl(tool);
  if (!url) return { ok: false, error: `${CHAT[tool].label} is not set up: paste its incoming-webhook URL in Administration > Integrations > ${CHAT[tool].label}.`, notSet: true };
  const r = await post(url, chatBody(tool, text, link), {});
  await logDelivery(null, `${tool}`, 'chat', r, 1);
  return r;
}
// a CRM event to Slack / Teams when the event is ticked for that tool (called by crm/events.js; imports are not posted one by one)
async function chatEvent(event, { kind, record, before, via } = {}) {
  const sw = await W.switches();
  if (!sw.chatOn || via === 'import') return 0;
  let n = 0;
  for (const tool of ['slack', 'teams']) {
    const list = sw[`${tool}Events`] || [];
    if (!list.includes(event) && !list.includes('*')) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await postChat(tool, chatText(event, kind, record, before), linkFor(kind, record)).catch(() => ({ ok: false }));
    if (r.ok) n += 1;
  }
  return n;
}
async function chatStatus(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees this.');
  const sw = await W.switches();
  return S.okBody({ on: sw.chatOn, slack: { set: !!(await chatUrl('slack')), events: sw.slackEvents }, teams: { set: !!(await chatUrl('teams')), events: sw.teamsEvents }, events: EVENTS.map(([name, label]) => ({ name, label })) });
}
async function chatTest(user, tool) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sends a test.');
  if (!CHAT[tool]) return S.fail(400, 'Slack or Teams?');
  const r = await postChat(tool, `TeamLink CRM test message from ${user.name || 'TeamLink'}`, '');
  return S.okBody({ ok: !!r.ok, message: r.ok ? `Posted to ${CHAT[tool].label}.` : (r.error || 'It did not go.') });
}

// ---- CRM API keys ------------------------------------------------------------------------------------------------------------------------
const keyOut = (k) => ({ id: k.id, label: k.label, prefix: k.prefix, scope: k.scope, ips: k.ips || '', userId: k.userId, userName: k.userName, createdByName: k.createdByName, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, uses: k.uses || 0, revokedAt: k.revokedAt });
async function listKeys(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the API keys.');
  const sw = await W.switches();
  const rows = await W.all('SELECT * FROM "CrmApiKey" ORDER BY "createdAt" DESC');
  return S.okBody({ on: sw.apiOn, keys: rows.map(keyOut), base: '/api/crm-api/v1', docs: '/api/crm-api/v1/openapi.json' });
}
// a key for a person on the CRM team (default: the one making it); scope read | write
async function createKey(user, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin makes API keys.');
  const forId = S.clip(body.userId, 60) || user.id;
  let forName = user.name || null;
  if (forId !== user.id) {
    const o = (await S.ownerOptions()).find((x) => x.id === forId);
    if (!o) return S.fail(400, 'Pick a person on the sales team.');
    forName = o.name;
  }
  const scope = body.scope === 'write' ? 'write' : 'read';
  const ips = String(body.ips || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ips.some((ip) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(ip))) return S.fail(400, 'Addresses look like 203.0.113.7 (or leave it empty).');
  const key = `crmk_${crypto.randomBytes(24).toString('base64url')}`;
  const row = await W.insert('CrmApiKey', { id: newId('key'), userId: forId, userName: forName, label: S.clip(body.label, 80) || 'CRM API key', prefix: key.slice(0, 9), keyHash: sha(key), scope, ips: ips.join(',') || null, createdById: user.id, createdByName: user.name || null, createdAt: now() });
  await S.audit(user, 'CRM API key made', 'CrmApiKey', row.id, `${row.label} · ${scope} · acts as ${forName || forId}`);
  return S.okBody({ ok: true, key, apiKey: keyOut(row), note: 'Copy it now: it is shown only once. It acts as the person it belongs to, with their CRM rights.' });
}
async function revokeKey(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin removes API keys.');
  const row = await W.one('SELECT * FROM "CrmApiKey" WHERE "id" = ?', String(id || ''));
  if (!row) return S.fail(404, 'This key is not there.');
  if (!row.revokedAt) await W.update('CrmApiKey', row.id, { revokedAt: now() });
  await S.audit(user, 'CRM API key revoked', 'CrmApiKey', row.id, row.label);
  return S.okBody({ ok: true });
}
const ipOf = (req) => String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
function ipAllowed(list, ip) {
  if (!list) return true;
  return list.split(',').some((a) => {
    if (!a.includes('/')) return a === ip;
    const [base, bits] = a.split('/');
    const toN = (s) => s.split('.').reduce((n, x) => (n * 256) + Number(x), 0);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
    const b = Number(bits); const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return ((toN(base) & mask) >>> 0) === ((toN(ip) & mask) >>> 0);
  });
}
// the person a request's key acts as: { user, key } or { status, error }
async function identityOfKey(req) {
  const sw = await W.switches();
  if (!sw.apiOn) return { status: 403, error: 'The CRM API is switched off. An Admin turns it on in CRM > Dashboard > Automation > Switches.' };
  const h = String(req.headers.authorization || '');
  const raw = h.startsWith('Bearer crmk_') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  if (!/^crmk_[A-Za-z0-9_-]{20,}$/.test(raw)) return { status: 401, error: 'A CRM API key is needed: Authorization: Bearer crmk_... (or X-API-Key).' };
  const key = await W.one('SELECT * FROM "CrmApiKey" WHERE "keyHash" = ? AND "revokedAt" IS NULL', sha(raw));
  if (!key) return { status: 401, error: 'This API key is not valid (or it was revoked).' };
  if (!ipAllowed(key.ips, ipOf(req))) return { status: 403, error: 'This key may not be used from this address.' };
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const user = await resolveIdentity(key.userId).catch(() => null);
  if (!user || (user.status && !/^active$/i.test(String(user.status)))) return { status: 401, error: 'The person this key belongs to cannot use the CRM any more.' };
  if (!(await S.crmRoleFor(user))) return { status: 403, error: 'The person this key belongs to is not on the CRM team any more.' };
  await W.run('UPDATE "CrmApiKey" SET "lastUsedAt" = ?, "uses" = COALESCE("uses", 0) + 1 WHERE "id" = ?', now(), key.id).catch(() => {});
  return { user, key };
}

// ---- the switches screen -----------------------------------------------------------------------------------------------------------
async function getSwitches(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the switches.');
  const sw = await W.switches();
  const { feedSalt, ...pub } = sw; // eslint-disable-line no-unused-vars
  return S.okBody({ switches: pub, canChange: isAdmin(user) });
}
const SWITCH_WORDS = { rulesOn: 'Rules run by themselves', scriptsOn: 'Rules may run scripts', webhooksOn: 'Webhooks', chatOn: 'Slack / Teams posts', apiOn: 'CRM API', mcpCrm: 'Outside AI tools read the CRM', mcpWrite: 'Outside AI tools add notes and follow-ups', schedulesOn: 'Scheduled report mails', repsSeeBoard: 'Salespeople see the whole leaderboard', calendarFeed: 'Calendar feed of follow-ups' };
async function setSwitches(user, body = {}) {
  const lists = ['slackEvents', 'teamsEvents'];
  const onlyLists = Object.keys(body).every((k) => lists.includes(k));
  if (!(onlyLists ? isManager(user) : isAdmin(user))) return S.fail(403, 'Only an Admin turns these on or off.');
  for (const k of lists) if (k in body) { const ev = (body[k] || []).filter((e) => EVENT_NAMES.includes(e) || e === '*'); body[k] = ev; } // eslint-disable-line no-param-reassign
  const before = await W.switches({ fresh: true });
  const next = await W.saveSwitches(body);
  const changed = Object.keys(SWITCH_WORDS).filter((k) => before[k] !== next[k]).map((k) => `${SWITCH_WORDS[k]}: ${next[k] ? 'on' : 'off'}`);
  if (changed.length) await S.audit(user, 'CRM automation switches changed', 'Crm', 'wave', changed.join('; '));
  const { feedSalt, ...pub } = next; // eslint-disable-line no-unused-vars
  return S.okBody({ ok: true, switches: pub });
}

// ---- the apps catalogue (15.08): what can be plugged into the CRM, and whether it is on ------------------------------------------------
async function apps(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the apps.');
  const sw = await W.switches();
  const { readConfig } = require('../utils/integrationStore'); // eslint-disable-line global-require
  const filled = async (id, label) => { const c = await readConfig(id).catch(() => ({ values: {} })); return !!String((c.values || {})[label] || '').trim(); };
  const hooks = await W.all('SELECT "source", "on" FROM "CrmWebhook"');
  const keys = await W.one('SELECT COUNT(*) AS "n" FROM "CrmApiKey" WHERE "revokedAt" IS NULL');
  const viaHook = (src) => hooks.some((h) => h.source === src && h.on);
  const st = (on, ready) => (on && ready ? 'On' : ready ? 'Set up, switched off' : 'Not set up');
  const list = [
    { key: 'webhooks', name: 'Webhooks', group: 'Developer', about: 'Tell any outside system when a lead, deal or invoice changes (signed POSTs).', status: st(sw.webhooksOn, hooks.length > 0), open: 'webhooks' },
    { key: 'zapier', name: 'Zapier', group: 'No-code', about: 'Zaps start on CRM events (REST hooks) and add leads, deals and follow-ups through the CRM API.', status: st(sw.apiOn, Number(keys && keys.n) > 0 || viaHook('zapier')), open: 'api' },
    { key: 'make', name: 'Make', group: 'No-code', about: 'Scenarios watch CRM events (webhooks) and act with the CRM API.', status: st(sw.apiOn, viaHook('make') || Number(keys && keys.n) > 0), open: 'api' },
    { key: 'n8n', name: 'n8n', group: 'No-code', about: 'Workflows trigger on CRM webhooks and call the CRM API (HTTP Request node).', status: st(sw.apiOn, viaHook('n8n') || Number(keys && keys.n) > 0), open: 'api' },
    { key: 'api', name: 'CRM API', group: 'Developer', about: 'Read and write leads, deals, customers, contacts, follow-ups with an API key (OpenAPI file included).', status: st(sw.apiOn, Number(keys && keys.n) > 0), open: 'api' },
    { key: 'mcp', name: 'AI tools (MCP)', group: 'AI', about: 'Claude Desktop and other AI tools read your CRM through the TeamLink MCP server, only what you may see.', status: st(sw.mcpCrm, true), open: 'api' },
    { key: 'slack', name: 'Slack', group: 'Chat', about: 'Won deals, new leads and more posted to a Slack channel.', status: st(sw.chatOn, await filled('slack', URL_LABEL)), open: 'chat', needs: 'A Slack incoming-webhook URL (Administration > Integrations > Slack).' },
    { key: 'teams', name: 'Microsoft Teams', group: 'Chat', about: 'The same posts in a Teams channel.', status: st(sw.chatOn, await filled('teams', URL_LABEL)), open: 'chat', needs: 'A Teams incoming-webhook / Workflows URL (Administration > Integrations > Microsoft Teams).' },
    { key: 'calendar', name: 'Google Calendar / Outlook calendar', group: 'Calendar', about: 'Your follow-ups in your own calendar: subscribe to your private feed link.', status: st(sw.calendarFeed, true), open: 'api' },
    { key: 'contacts', name: 'Google Contacts / Outlook contacts', group: 'Contacts', about: 'Download the CRM contacts as a vCard file and import it.', status: 'On', open: 'api' },
    { key: 'reports', name: 'Scheduled reports by mail', group: 'Reports', about: 'Any saved report mailed daily, weekly or monthly to the sales team.', status: st(sw.schedulesOn, true), open: 'reports' },
    { key: 'tally', name: 'Tally / Zoho Books', group: 'Accounting', about: 'Posting CRM invoices to the ledger touches Accounts: it waits for the founder\'s decision. The invoice events above already go to any webhook.', status: 'Needs founder decision' },
    { key: 'razorpay', name: 'Razorpay / payment links', group: 'Payments', about: 'Online payment of CRM invoices.', status: (await filled('payments', 'Key ID')) ? 'Set up' : 'Needs an account', needs: 'A Razorpay account (Administration > Integrations > Payment Gateway).' },
    { key: 'exotel', name: 'Exotel calling', group: 'Phone', about: 'Calls from a lead through the cloud phone.', status: 'Needs an account', needs: 'An Exotel account (Administration > Integrations > Cloud Telephony).' },
  ];
  return S.okBody({ apps: list });
}

// ---- the calendar feed (15.04 / 15.05) -----------------------------------------------------------------------------------------------
async function feedSalt() {
  const sw = await W.switches({ fresh: true });
  if (sw.feedSalt) return sw.feedSalt;
  const salt = crypto.randomBytes(16).toString('hex');
  await W.saveSwitches({ feedSalt: salt });
  return salt;
}
const feedToken = async (userId) => `${userId}.${crypto.createHmac('sha256', await feedSalt()).update(`crm-feed:${userId}`).digest('base64url').slice(0, 32)}`;
async function myFeed(user) {
  const sw = await W.switches();
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const path = `/api/crm-api/calendar/${await feedToken(user.id)}.ics`;
  return S.okBody({ on: sw.calendarFeed, path, url: base ? `${base}${path}` : path });
}
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
async function feedIcs(token) {
  const sw = await W.switches();
  if (!sw.calendarFeed) return { status: 403, text: 'The CRM calendar feed is switched off.' };
  const userId = String(token || '').replace(/\.ics$/, '').split('.')[0];
  const want = await feedToken(userId);
  const got = String(token || '').replace(/\.ics$/, '');
  if (!userId || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return { status: 404, text: 'Not found.' };
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const user = await resolveIdentity(userId).catch(() => null);
  if (!user || !(await S.crmRoleFor(user))) return { status: 404, text: 'Not found.' };
  const from = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await DB.all('SELECT * FROM "CrmTask" WHERE "ownerId" = ? AND "status" = \'Open\' AND "dueDate" >= ? ORDER BY "dueDate" LIMIT 500', user.id, from);
  const stamp = now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamLink//CRM follow-ups//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:TeamLink CRM follow-ups', 'X-WR-TIMEZONE:Asia/Kolkata'];
  for (const t of rows) {
    const d = t.dueDate.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${t.id}@teamlink-crm`, `DTSTAMP:${stamp}`);
    if (t.dueTime) {
      const [hh, mm] = t.dueTime.split(':').map(Number);
      const start = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), hh, mm) - 5.5 * 3600000);
      const fmt = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      lines.push(`DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 30 * 60000))}`);
    } else {
      const next = new Date(Date.parse(`${t.dueDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
    }
    lines.push(`SUMMARY:${icsEsc(`${t.type ? `${t.type}: ` : ''}${t.title}`)}`, `DESCRIPTION:${icsEsc(`Priority ${t.priority || 'Medium'}. Open TeamLink CRM > Follow-ups.`)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { status: 200, text: `${lines.join('\r\n')}\r\n` };
}

// ---- contacts as vCard (Google Contacts / Outlook import) -----------------------------------------------------------------------------
async function contactsVcf(user) {
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r, 'c.');
  const rows = await DB.all(`SELECT c.*, a."name" AS "accountName" FROM "CrmContact" c LEFT JOIN "CrmAccount" a ON a."id" = c."accountId" WHERE ${sc.sql} ORDER BY c."name" LIMIT 5000`, ...sc.params);
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, ' ');
  const cards = rows.map((c) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name)}`, `N:${esc(c.name)};;;;`, c.accountName ? `ORG:${esc(c.accountName)}` : null, c.designation ? `TITLE:${esc(c.designation)}` : null, c.phone ? `TEL;TYPE=WORK,VOICE:${esc(c.phone)}` : null, c.email ? `EMAIL;TYPE=INTERNET:${esc(c.email)}` : null, 'NOTE:From TeamLink CRM', 'END:VCARD'].filter(Boolean).join('\r\n'));
  await require('./analytics').logExport(user, 'Contacts (vCard)', 'vcf', rows.length, {}).catch(() => {}); // eslint-disable-line global-require
  await S.audit(user, 'CRM contacts downloaded', 'Crm', 'contacts:vcf', `${rows.length} contacts as vCard`);
  return { status: 200, text: `${cards.join('\r\n')}\r\n`, name: `crm-contacts-${S.istToday()}.vcf`, rows: rows.length };
}

module.exports = {
  EVENTS, EVENT_NAMES, shape, nameOf, listHooks, addHook, editHook, removeHook, testHook, deliverEvent, post, logDelivery, chatEvent, chatStatus, chatTest, postChat, chatText,
  listKeys, createKey, revokeKey, identityOfKey, getSwitches, setSwitches, apps, myFeed, feedIcs, contactsVcf, isManager, isAdmin, URL_LABEL, decrypt,
};
