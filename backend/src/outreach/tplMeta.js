// ---------------------------------------------------------------------------
// WHATSAPP TEMPLATES <-> META (the real thing, only when the WhatsApp Cloud account is connected: utils/whatsappCloud.js).
//   state()          { connected, why }  - never the token, never a secret.
//   buildPayload(t)  the body Meta's "message_templates" call wants, or { error } when this template needs something this screen cannot send yet.
//   submit(user, id) policy check -> POST /{waba-id}/message_templates -> the template becomes "In review" (waApprovalStatus 'pending') and the
//                    answer is kept in extra.meta / extra.review. It NEVER marks anything Approved on its own.
//   (both also keep the per-account record in outreach/tplWaba.js, so "send to every account" and this single send always agree)
//   sync(user, id)   asks Meta for the template's real status and copies it (Approved / Rejected / In review). Only Meta's own answer is copied.
// In a test (TEST_MODE / sandbox) nothing is called: the answer is "test mode". Without a connected account the answer is the plain "Not connected" text.
// ---------------------------------------------------------------------------
const S = require('./store');
const T = require('./templates');
const P = require('./tplPolicy');
const { logAudit } = require('../utils/audit');

const NOT_CONNECTED = 'Not connected: Administration > Integrations > WhatsApp Business. Connect it there, then come back and send this template to Meta.';
const META_STATUS = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', PENDING_DELETION: 'pending', REJECTED: 'rejected', PAUSED: 'approved', DISABLED: 'rejected' };

async function config(numberId) { return require('../utils/whatsappCloud').whatsappConfig(numberId ? { numberId } : undefined); } // eslint-disable-line global-require
// { connected, wabaReady, display, why }: only yes / no and words; the token stays inside whatsappCloud.js
async function state(numberId) {
  try {
    const c = await config(numberId);
    return { connected: !!c.configured, wabaReady: !!(c.configured && c.wabaId), display: c.display || '', why: c.configured ? (c.wabaId ? '' : 'The WhatsApp Business account ID (WABA ID) is missing in Administration > Integrations > WhatsApp Business, so templates cannot be sent to Meta from here.') : NOT_CONNECTED };
  } catch { return { connected: false, wabaReady: false, display: '', why: NOT_CONNECTED }; }
}
const sandbox = () => require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require

// Meta's components for a template (named variables become {{1}} {{2}} ... with the example values Meta asks for)
function buildPayload(t) {
  const ex = T.parseExtra(t.extra);
  const category = T.catOf(t.category, t.promotional);
  if (category === 'Authentication') return { error: 'Authentication templates use a fixed layout that Meta writes itself. This screen cannot send them yet: make that template in Meta Business Manager.' };
  if (ex.callPermission) return { error: 'Call-permission templates cannot be sent to Meta from this screen yet.' };
  const map = P.mapping(t.body);
  const components = [];
  const ht = ex.headerType || 'none';
  if (ht === 'text' && ex.headerText) {
    const hm = P.mapping(ex.headerText);
    components.push({ type: 'HEADER', format: 'TEXT', text: hm.text, ...(hm.params.length ? { example: { header_text: [hm.params[0].example] } } : {}) });
  } else if (ht === 'location') components.push({ type: 'HEADER', format: 'LOCATION' });
  else if (['image', 'video', 'document'].includes(ht)) return { error: 'A picture, video or document header needs Meta\'s file upload step, which is not built here yet. Use a text header (or none) to send from here, or send this template from Meta Business Manager.' };
  components.push({ type: 'BODY', text: map.text, ...(map.params.length ? { example: { body_text: [map.params.map((p) => p.example)] } } : {}) });
  if (ex.footer) components.push({ type: 'FOOTER', text: ex.footer });
  const btns = [];
  for (const b of ex.buttons || []) {
    if (b.type === 'reply') btns.push({ type: 'QUICK_REPLY', text: b.label });
    else if (b.type === 'url') btns.push({ type: 'URL', text: b.label, url: b.url });
    else if (b.type === 'phone') btns.push({ type: 'PHONE_NUMBER', text: b.label, phone_number: `${(b.country || '+91').replace(/\D/g, '')}${String(b.phone).replace(/\D/g, '')}` });
    else if (b.type === 'code') btns.push({ type: 'COPY_CODE', example: b.code });
    else return { error: `The "${b.label || b.type}" button type cannot be sent to Meta from this screen yet (Flow, Order details and Call on WhatsApp buttons are planned).` };
  }
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
  return { payload: { name: P.slug(t.waTemplateName || t.name), language: String(t.waLanguage || 'en_US'), category: category.toUpperCase(), components } };
}

const verdictWords = (r) => (r.errors ? 'Will be refused' : (r.warnings ? 'Can be sent, with advice' : 'Meets the rules'));
function policyInput(v) {
  const ex = v.extra || {};
  return { name: v.name, category: v.category, body: v.body, headerType: ex.headerType, headerText: ex.headerText, headerHasMedia: !!(ex.headerMedia && (ex.headerMedia.libraryId || ex.headerMedia.url)), locationName: ex.location && ex.location.name, footer: ex.footer, buttons: ex.buttons, callPermission: ex.callPermission };
}

async function writeBack(user, row, patch) {
  const cur = T.parseExtra(row.extra);
  const next = { ...cur, ...(patch.extra || {}) };
  await S.run('UPDATE "OutreachTemplate" SET extra = ?, waApprovalStatus = COALESCE(?, waApprovalStatus), waTemplateName = COALESCE(?, waTemplateName), updatedAt = ? WHERE id = ?', JSON.stringify(next), patch.status || null, patch.waName || null, Date.now(), row.id);
}

async function submit(user, id, opts = {}) {
  const row = await T.get(user, id);
  if (!row || row.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (row.channel !== 'whatsapp') return { error: 'Only WhatsApp templates are sent to Meta.', status: 400 };
  if (!T.canEdit(user, row.audience)) return { error: 'You cannot change this template.', status: 403 };
  const v = T.view(row);
  const pol = P.check(policyInput(v));
  if (pol.errors) return { error: `Cannot send yet: ${pol.issues.find((i) => i.severity === 'error').message}`, status: 400, issues: pol.issues };
  const st = await state(opts.numberId);
  if (sandbox()) return { error: 'This is test mode: nothing is sent to Meta.', status: 409, code: 'test_mode' };
  if (!st.connected) return { error: NOT_CONNECTED, status: 409, code: 'not_connected' };
  if (!st.wabaReady) return { error: st.why, status: 409, code: 'no_waba' };
  const built = buildPayload(v);
  if (built.error) return { error: built.error, status: 400 };
  const cfg = await config(opts.numberId);
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const { VERSION } = require('../utils/whatsappCloud'); // eslint-disable-line global-require
  const res = await core.httpJson(`${cfg.base}/${VERSION}/${encodeURIComponent(cfg.wabaId)}/message_templates`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(built.payload) });
  const submittedAt = new Date().toISOString();
  if (!(res.ok && res.json && res.json.id)) {
    const e = (res.json && res.json.error) || {};
    const said = res.networkError || e.error_user_msg || e.message || res.text || `HTTP ${res.status}`;
    await writeBack(user, row, { extra: { review: { submittedAt, by: user.name, localVerdict: verdictWords(pol), issues: pol.issues, metaError: String(said).slice(0, 400) } } });
    return { error: `Meta did not accept it: ${String(said).slice(0, 300)}`, status: 502 };
  }
  const status = META_STATUS[String(res.json.status || 'PENDING').toUpperCase()] || 'pending';
  await writeBack(user, row, { status, waName: built.payload.name, extra: { meta: { id: String(res.json.id), status: String(res.json.status || 'PENDING'), category: res.json.category || built.payload.category, submittedAt, wabaId: cfg.wabaId || undefined }, review: { submittedAt, by: user.name, localVerdict: verdictWords(pol), issues: pol.issues, source: 'meta' } } });
  await require('./tplWaba').mirror(row.id, cfg.wabaId, { status, metaId: String(res.json.id), metaStatus: String(res.json.status || 'PENDING'), reason: '', submittedAt }); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp template sent to Meta', entity: 'OutreachTemplate', entityId: row.id, toValue: built.payload.name });
  return { template: T.view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', row.id))[0]), sent: true };
}

async function sync(user, id, opts = {}) {
  const row = await T.get(user, id);
  if (!row || row.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (row.channel !== 'whatsapp') return { error: 'Only WhatsApp templates are checked with Meta.', status: 400 };
  const st = await state(opts.numberId);
  if (sandbox()) return { error: 'This is test mode: Meta is not asked.', status: 409, code: 'test_mode' };
  if (!st.connected) return { error: NOT_CONNECTED, status: 409, code: 'not_connected' };
  if (!st.wabaReady) return { error: st.why, status: 409, code: 'no_waba' };
  const cfg = await config(opts.numberId);
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const { VERSION } = require('../utils/whatsappCloud'); // eslint-disable-line global-require
  const name = P.slug(row.waTemplateName || row.name);
  const res = await core.httpJson(`${cfg.base}/${VERSION}/${encodeURIComponent(cfg.wabaId)}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,rejected_reason,quality_score`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return { error: `Meta could not be asked: ${String((res.json && res.json.error && res.json.error.message) || res.networkError || res.text || res.status).slice(0, 200)}`, status: 502 };
  const hit = res.json && Array.isArray(res.json.data) ? res.json.data.find((d) => d.name === name) : null;
  if (!hit) return { error: 'Meta does not know a template with this name yet. Send it to Meta first.', status: 404 };
  const status = META_STATUS[String(hit.status || '').toUpperCase()] || 'pending';
  const cur = T.parseExtra(row.extra);
  await writeBack(user, row, { status, extra: { meta: { ...(cur.meta || {}), status: String(hit.status), category: hit.category, reason: hit.rejected_reason && hit.rejected_reason !== 'NONE' ? hit.rejected_reason : '', quality: hit.quality_score && hit.quality_score.score ? hit.quality_score.score : '', checkedAt: new Date().toISOString(), wabaId: cfg.wabaId || (cur.meta || {}).wabaId || undefined }, review: { ...(cur.review || {}), reviewedAt: status === 'pending' ? undefined : new Date().toISOString(), source: 'meta' } } });
  await require('./tplWaba').mirror(row.id, cfg.wabaId, { status, metaId: (cur.meta || {}).id || null, metaStatus: String(hit.status), reason: hit.rejected_reason && hit.rejected_reason !== 'NONE' ? String(hit.rejected_reason) : '', checkedAt: new Date().toISOString() }); // eslint-disable-line global-require
  return { template: T.view((await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', row.id))[0]) };
}

module.exports = { state, buildPayload, submit, sync, policyInput, verdictWords, writeBack, NOT_CONNECTED };
