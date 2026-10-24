// ---------------------------------------------------------------------------
// TEMPLATES PAGE, the parts around the template hub (outreach/hub.js stays the ONE source for WhatsApp / SMS / Email templates):
//   tree(user)        the left navigation: WhatsApp / SMS / RCS / Voice / Email, the accounts under each, the Flows, the counts
//   list(user, ...)   the rows of one channel (hub items, plus saved voice scripts and the built-in call scripts for Voice)
//   flows             WhatsApp Flow definitions (OmniWaFlow): saved only, publishing is Planned
//   voice scripts     saved voice scripts (OmniVoiceScript) next to the built-in read-only call scripts
// "Accounts": TeamLink has ONE WhatsApp Business account, one SMS sender and one email sender (Settings > Sender details, Administration > Integrations),
// so each of those channels shows one account row with the real numbers/ids. RCS accounts are the assistants saved with the wizard (rcs.js).
// Nothing here sends anything.
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const Hub = require('./hub');
const Own = require('./tplOwn');
const Rcs = require('./rcs');
const Meta = require('./tplMeta');
const Pol = require('./policy');
const { logAudit } = require('../utils/audit');

const CH_WORD = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const FLOW_TYPES = ['Question', 'Text input', 'Dropdown', 'Date picker', 'Form', 'Terminal'];
const txt = (v, n) => S.clip(v, n);

// WhatsApp words (never "Draft")
const WA_WORDS = { None: ['draft', 'Not sent to Meta'], Pending: ['scheduled', 'In review'], Approved: ['live', 'Approved'], Rejected: ['red', 'Rejected'] };
function decorate(i) {
  const out = { ...i };
  if (i.wa) { const [tone, word] = WA_WORDS[i.wa.status] || ['draft', 'Not sent to Meta']; out.statusTone = tone; out.statusWord = word; } else if (i.channel === 'SMS' && i.source === 'outreach') {
    out.statusTone = i.ready ? 'live' : 'warn'; out.statusWord = i.ready ? 'Ready' : (i.readyWhy || 'Needs DLT details');
  } else { out.statusTone = 'live'; out.statusWord = i.canEdit || i.source === 'script' ? (i.source === 'script' ? 'Built in' : 'Ready') : 'Ready'; }
  return out;
}

async function waAccount() {
  const st = await Meta.state();
  let nums = [];
  try { nums = await Pol.waNumbers(); } catch { nums = []; }
  const set = await S.settings().catch(() => ({}));
  const shown = set.whatsappNumber ? `+${String(set.whatsappNumber).slice(0, -10)} ${String(set.whatsappNumber).slice(-10, -5)} ${String(set.whatsappNumber).slice(-5)}`.replace('+ ', '+') : '';
  return { connected: st.connected, wabaReady: st.wabaReady, why: st.why, number: shown, numbers: nums.map((n) => ({ label: n.label, masked: n.numberMasked, departments: n.departments })) };
}

async function ownVoice(u) {
  await Own.ensure();
  return (await S.q('SELECT * FROM "OmniVoiceScript" WHERE deletedAt IS NULL ORDER BY updatedAt DESC')).filter((r) => Own.sees(u, r));
}
const voiceView = (u, r) => ({
  key: `voice:${r.id}`, id: r.id, source: 'voice', sourceWord: 'Voice script', name: r.name, channel: 'Voice', category: r.category || 'Utility', language: r.language || '', body: r.script || '', audio: Own.parse(r.audio, null),
  department: r.department || '', updatedAt: S.iso(r.updatedAt), byName: r.createdByName || '', canEdit: Own.mayWrite(u) && Own.mayChange(u, r), statusTone: 'live', statusWord: 'Ready', where: ['Omni-Channel'],
});

// ---- the navigation tree ---------------------------------------------------------------------------------------
async function tree(u, { where = 'Omni-Channel', dept = '' } = {}) {
  const hub = await Hub.list(u, { where });
  const voice = await ownVoice(u);
  const builtin = (await Hub.list(u, { where: 'all', channel: 'Call script' })).items.length;
  const agents = await Rcs.agents(u);
  const flows = await flowList(u);
  const set = await S.settings().catch(() => ({}));
  const ch = hub.channels || {};
  const wa = await waAccount();
  return {
    where, dept,
    groups: [
      { key: 'whatsapp', label: 'WhatsApp', icon: '📞', color: '#11985a', families: [{ key: 'message', label: 'Message Templates', accounts: [{ id: 'whatsapp', name: 'WhatsApp Business', sub: wa.connected ? (wa.number || 'Connected') : 'Not connected', connected: wa.connected, count: ch.WhatsApp || 0 }] }], flows: flows.map((f) => ({ id: f.id, name: f.name, screens: f.screens.length })) },
      { key: 'sms', label: 'SMS', icon: '💬', color: '#4d7ddb', families: [{ key: 'all', label: 'All SMS Templates', accounts: [{ id: 'sms', name: 'SMS', sub: set.smsSenderId ? `Sender ID ${set.smsSenderId}` : 'Sender ID not set', connected: !!set.smsSenderId, count: ch.SMS || 0 }] }] },
      { key: 'rcs', label: 'RCS', icon: '💭', color: '#0891b2', families: [{ key: 'agents', label: 'RCS Assistants', accounts: agents.map((a) => ({ id: a.id, name: a.name, sub: 'Saved here, not sent to a carrier', connected: false, count: a.templates })) }] },
      { key: 'voice', label: 'Voice', icon: '🎙', color: '#5b6ee1', families: [{ key: 'scripts', label: 'Call Scripts', accounts: [{ id: 'voice', name: 'Call scripts', sub: 'What a call says', connected: true, count: voice.length + builtin }] }] },
      { key: 'email', label: 'Email', icon: '@', color: '#666fd3', families: [{ key: 'all', label: 'All Email Templates', accounts: [{ id: 'email', name: 'Email', sub: set.fromEmail ? set.fromEmail : 'From address not set', connected: !!set.fromEmail, count: ch.Email || 0 }] }] },
    ],
    queue: hub.queue || { pending: 0, notSent: 0, rejected: 0 },
    whatsapp: wa,
    counts: hub.counts || {},
  };
}

// ---- lists -------------------------------------------------------------------------------------------------------
async function list(u, { channel = 'whatsapp', where = 'Omni-Channel', q = '', approval = '', dept = '' } = {}) {
  if (channel === 'voice') {
    const own = (await ownVoice(u)).map((r) => voiceView(u, r));
    const built = (await Hub.list(u, { where: 'all', channel: 'Call script', q })).items.map((i) => ({ ...decorate(i), statusTone: 'draft', statusWord: 'Built in' }));
    const needle = String(q || '').trim().toLowerCase();
    const mine = own.filter((i) => (!dept || !i.department || i.department.toLowerCase() === dept.toLowerCase()) && (!needle || `${i.name} ${i.body}`.toLowerCase().includes(needle)));
    const items = [...mine, ...built];
    return { items, total: items.length, queue: null };
  }
  const word = CH_WORD[channel];
  if (!word) return { items: [], total: 0 };
  const hub = await Hub.list(u, { where, q, channel: word, approval });
  let items = hub.items.map(decorate);
  if (channel === 'whatsapp') items = await require('./tplWaba').decorate(items); // eslint-disable-line global-require
  if (dept) items = items.filter((i) => !i.department || String(i.department).toLowerCase() === dept.toLowerCase());
  return { items, total: items.length, queue: hub.queue, truncated: hub.truncated };
}

// ---- WhatsApp Flows -----------------------------------------------------------------------------------------------
const flowView = (u, r) => ({ id: r.id, name: r.name, status: r.status || 'saved', statusWord: 'Saved (publishing is planned)', screens: Own.parse(r.screens, []), updatedAt: S.iso(r.updatedAt), canEdit: Own.mayWrite(u) && Own.mayChange(u, r), byName: r.createdByName || '' });
async function flowList(u) {
  await Own.ensure();
  return (await S.q('SELECT * FROM "OmniWaFlow" WHERE deletedAt IS NULL ORDER BY name COLLATE NOCASE')).filter((r) => Own.sees(u, r)).map((r) => flowView(u, r));
}
async function flowGet(u, id) {
  await Own.ensure();
  const r = (await S.q('SELECT * FROM "OmniWaFlow" WHERE id = ?', String(id || '')))[0];
  return r && Own.sees(u, r) ? r : null;
}
function cleanScreens(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 12).map((s) => ({ name: txt(s && s.name, 80), type: FLOW_TYPES.includes(s && s.type) ? s.type : 'Question' }));
}
async function flowCreate(u, b, dept) {
  await Own.ensure();
  if (!Own.mayWrite(u)) return { error: 'You cannot write templates.', status: 403 };
  const name = txt(b.name, 80);
  if (!name) return { error: 'Give the flow a name.', status: 400 };
  if (await Own.nameClash('OmniWaFlow', name)) return { error: 'A flow with that name already exists.', status: 409 };
  const id = S.newId('wf'); const now = Date.now();
  await S.run('INSERT INTO "OmniWaFlow" (id, name, status, screens, audience, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', id, name, 'saved', JSON.stringify([{ name: 'First screen', type: 'Question' }, { name: 'Done', type: 'Terminal' }]), Own.audienceOfWriter(u), dept || null, u.id, u.name, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'WhatsApp Flow saved', entity: 'OmniWaFlow', entityId: id, toValue: name });
  return { flow: flowView(u, (await S.q('SELECT * FROM "OmniWaFlow" WHERE id = ?', id))[0]) };
}
async function flowUpdate(u, id, b) {
  const r = await flowGet(u, id);
  if (!r) return { error: 'This flow was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot change this flow.', status: 403 };
  const name = b.name !== undefined ? txt(b.name, 80) : r.name;
  if (!name) return { error: 'Give the flow a name.', status: 400 };
  if (await Own.nameClash('OmniWaFlow', name, r.id)) return { error: 'A flow with that name already exists.', status: 409 };
  const screens = b.screens !== undefined ? cleanScreens(b.screens) : Own.parse(r.screens, []);
  if (screens.length < 2) return { error: 'A flow needs at least two screens.', status: 400 };
  if (screens.some((s) => !s.name)) return { error: 'Every screen needs a title.', status: 400 };
  await S.run('UPDATE "OmniWaFlow" SET name = ?, screens = ?, updatedAt = ? WHERE id = ?', name, JSON.stringify(screens), Date.now(), r.id);
  return { flow: flowView(u, (await S.q('SELECT * FROM "OmniWaFlow" WHERE id = ?', r.id))[0]) };
}
async function flowRemove(u, id) {
  const r = await flowGet(u, id);
  if (!r) return { error: 'This flow was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot delete this flow.', status: 403 };
  await S.run('UPDATE "OmniWaFlow" SET deletedAt = ? WHERE id = ?', Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'WhatsApp Flow deleted', entity: 'OmniWaFlow', entityId: r.id });
  return { ok: true };
}

// ---- saved voice scripts ------------------------------------------------------------------------------------------
function voiceClean(b, cur = {}) {
  const name = b.name !== undefined ? txt(b.name, 80) : (cur.name || '');
  if (name.length < 2) return { error: 'Give the script a name.', status: 400 };
  const script = b.script !== undefined ? String(b.script).slice(0, 4000) : (cur.script || '');
  if (!script.trim()) return { error: 'The voice script is empty.', status: 400 };
  const category = ['Utility', 'Marketing'].includes(b.category) ? b.category : (cur.category || 'Utility');
  const a = b.audio !== undefined ? b.audio : Own.parse(cur.audio, null);
  const audio = a && (a.libraryId || a.url) ? { libraryId: txt(a.libraryId, 60), name: txt(a.name, 120), url: txt(a.url, 600) } : null;
  return { name, script, category, language: b.language !== undefined ? txt(b.language, 12) : (cur.language || 'en_US'), audio };
}
async function voiceCreate(u, b, dept) {
  await Own.ensure();
  if (!Own.mayWrite(u)) return { error: 'You cannot write templates.', status: 403 };
  const f = voiceClean(b);
  if (f.error) return f;
  if (await Own.nameClash('OmniVoiceScript', f.name)) return { error: `You already have a voice script called "${f.name}".`, status: 409 };
  const id = S.newId('vs'); const now = Date.now();
  await S.run('INSERT INTO "OmniVoiceScript" (id, name, category, language, script, audio, status, audience, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, f.name, f.category, f.language, f.script, f.audio ? JSON.stringify(f.audio) : null, 'active', Own.audienceOfWriter(u), dept || null, u.id, u.name, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Voice script saved', entity: 'OmniVoiceScript', entityId: id, toValue: f.name });
  return { item: voiceView(u, (await S.q('SELECT * FROM "OmniVoiceScript" WHERE id = ?', id))[0]) };
}
async function voiceGet(u, id) {
  await Own.ensure();
  const r = (await S.q('SELECT * FROM "OmniVoiceScript" WHERE id = ?', String(id || '')))[0];
  return r && Own.sees(u, r) ? r : null;
}
async function voiceUpdate(u, id, b) {
  const r = await voiceGet(u, id);
  if (!r) return { error: 'This script was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot change this script.', status: 403 };
  const f = voiceClean(b, r);
  if (f.error) return f;
  if (await Own.nameClash('OmniVoiceScript', f.name, r.id)) return { error: `You already have a voice script called "${f.name}".`, status: 409 };
  await S.run('UPDATE "OmniVoiceScript" SET name = ?, category = ?, language = ?, script = ?, audio = ?, updatedAt = ? WHERE id = ?', f.name, f.category, f.language, f.script, f.audio ? JSON.stringify(f.audio) : null, Date.now(), r.id);
  return { item: voiceView(u, (await S.q('SELECT * FROM "OmniVoiceScript" WHERE id = ?', r.id))[0]) };
}
async function voiceRemove(u, id) {
  const r = await voiceGet(u, id);
  if (!r) return { error: 'This script was not found.', status: 404 };
  if (!(Own.mayWrite(u) && Own.mayChange(u, r))) return { error: 'You cannot delete this script.', status: 403 };
  await S.run('UPDATE "OmniVoiceScript" SET deletedAt = ? WHERE id = ?', Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Voice script deleted', entity: 'OmniVoiceScript', entityId: r.id });
  return { ok: true };
}

module.exports = { tree, list, decorate, flowList, flowGet, flowCreate, flowUpdate, flowRemove, FLOW_TYPES, voiceCreate, voiceUpdate, voiceRemove, voiceGet, ownVoice, voiceView, A };
