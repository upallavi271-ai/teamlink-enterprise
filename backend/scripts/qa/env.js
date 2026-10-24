// Test environment: fake SMS + WhatsApp accounts on the SANDBOX, switches on, restored afterwards.
const crypto = require('crypto');
const { L } = require('./fx');
const P = L.prisma;
const SECRET = 'zz-oc-app-secret-0123456789';
const VT = 'zz-oc-verify';
const DLR = 'zz-oc-dlr';
const saved = {};

async function setup(sa) {
  for (const id of ['sms', 'whatsapp', 'email-inbox', 'telephony']) saved[id] = await P.integration.findUnique({ where: { id } });
  for (const k of ['interview-reminders', 'message-limits', 'omni-quiet', 'mailbox.checkpoint', 'mailbox.lastpoll']) saved[`as:${k}`] = await P.appSetting.findUnique({ where: { key: k } });
  await P.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: true, dayBefore: false, hourBefore: false }) }, update: { value: JSON.stringify({ enabled: true, dayBefore: false, hourBefore: false }) } });
  await L.put(sa, '/messaging/limits', { Email: { perMinute: 600, perDay: 5000 }, SMS: { perMinute: 600, perDay: 5000 }, WhatsApp: { perMinute: 600, perDay: 5000 } });
  await P.appSetting.deleteMany({ where: { key: 'omni-quiet' } });
  const wa = await L.put(sa, '/admin/integrations/whatsapp/configure', { values: {
    'Business phone number': '+15550000000', 'Phone number ID': 'PN1', 'WhatsApp Business ID': 'WABA1', 'Permanent access token': 'zz-fake-token',
    'Template language code': 'en', 'App secret (checks Meta webhook calls)': SECRET, 'Webhook verify token (any text you choose)': VT } });
  const sms = await L.put(sa, '/admin/integrations/sms/configure', { values: {
    'Provider (MSG91 / Fast2SMS / Twilio)': 'MSG91', 'Sender ID (6 chars) / Twilio From number': 'TMLINK', 'API key / Auth token': 'zz-fake-msg91-key',
    'DLT template ID — bulk / general': 'zz-flow-1', 'Delivery-report webhook secret (any text you choose)': DLR } });
  if (wa.status !== 200 || sms.status !== 200) throw new Error(`channel setup failed ${wa.status} ${sms.status}`);
}
async function restore() {
  for (const id of ['sms', 'whatsapp', 'email-inbox', 'telephony']) {
    if (saved[id]) await P.integration.update({ where: { id }, data: { values: saved[id].values, connected: saved[id].connected, enabled: saved[id].enabled, state: saved[id].state } }).catch(() => {});
    else await P.integration.deleteMany({ where: { id } }).catch(() => {});
  }
  for (const k of Object.keys(saved).filter((x) => x.startsWith('as:'))) {
    const key = k.slice(3);
    if (saved[k]) await P.appSetting.update({ where: { key }, data: { value: saved[k].value } }).catch(() => {});
    else await P.appSetting.deleteMany({ where: { key } }).catch(() => {});
  }
  await P.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'wa.window.9' } }, { key: { startsWith: 'wa.window.919' } }, { key: { startsWith: 'msg.optout.' } }] } }).catch(() => {});
}
const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const wrap = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'PN1' }, ...value } }] }] });
async function retry(fn) { for (let i = 0; i < 40; i += 1) { try { return await fn(); } catch (e) { if (i === 39) throw e; await new Promise((r) => setTimeout(r, 2000)); } } }
async function waInbound(e164, text, id) {
  const raw = JSON.stringify(wrap({ contacts: [{ profile: { name: 'Zz' }, wa_id: e164 }], messages: [{ from: e164, id: id || `wamid.IN${Date.now()}${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }));
  const r = await retry(() => fetch(`${L.API}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw }));
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function smsInbound(from, text) {
  const r = await retry(() => fetch(`${L.API}/webhooks/sms-inbound/msg91?key=${DLR}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: from, message: text, requestId: `zzin-${Date.now()}${Math.random()}` }) }));
  return { status: r.status, body: await r.json().catch(() => null) };
}
module.exports = { setup, restore, waInbound, smsInbound, sign, wrap, SECRET, VT, DLR, P, L };
