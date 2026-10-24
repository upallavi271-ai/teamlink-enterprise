// WhatsApp webhook + SMS delivery reports + call results — SANDBOX ONLY.
const crypto = require('crypto');
const L = require('./pc-lib');
const { prisma, api, check, sleep } = L;
const SECRET = 'zz-app-secret-0123456789';
const VT = 'zz-verify-token';
const DLR = 'zz-dlr-word';
const CALLKEY = 'zz-call-word';
const PHONE = '9000000071'; const E164 = '919000000071';
const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
async function hook(payload, goodSig = true) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${L.API}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': goodSig ? sign(raw) : 'sha256=deadbeef' }, body: raw });
  return { code: res.status, body: await res.json().catch(() => null) };
}
async function post(path, body, form) {
  const res = await fetch(`${L.API}${path}`, {
    method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  return { code: res.status, body: await res.json().catch(() => null) };
}
const wrap = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'PN1' }, ...value } }] }] });

(async () => {
  const sa = await L.login();
  const beforeWa = await prisma.integration.findUnique({ where: { id: 'whatsapp' } });
  const beforeSms = await prisma.integration.findUnique({ where: { id: 'sms' } });
  const beforeTel = await prisma.integration.findUnique({ where: { id: 'telephony' } });
  const sw = await prisma.appSetting.findUnique({ where: { key: 'interview-reminders' } });
  let cand = null; const jobIds = [];
  try {
    await prisma.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: true }) }, update: { value: JSON.stringify({ enabled: true }) } });
    const conf = await api('PUT', '/admin/integrations/whatsapp/configure', { values: {
      'Business phone number': '+15550000000', 'Phone number ID': 'PN1', 'WhatsApp Business ID': 'WABA1', 'Permanent access token': 'zz-fake-token',
      'Template language code': 'en', 'App secret (checks Meta webhook calls)': SECRET, 'Webhook verify token (any text you choose)': VT } });
    check('WhatsApp configured (fake)', conf.code === 200, JSON.stringify(conf.body).slice(0, 200));

    // ---- WhatsApp ------------------------------------------------------------------
    let r = await fetch(`${L.API}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=12345`);
    check('GET verify: right token -> challenge echoed', r.status === 200 && (await r.text()) === '12345');
    r = await fetch(`${L.API}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=999`);
    check('GET verify: wrong token -> 403', r.status === 403);
    cand = await prisma.candidate.create({ data: { name: 'ZZTEST WaHook', email: 'zztest.wahook@zzmm-sandbox.in', phone: PHONE, source: 'Direct' } });
    const msg = await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'WhatsApp', template: 'MANUAL', trigger: 'Manual', recipient: `+${E164}`, body: 'ZZTEST hello', status: 'SENT', providerRef: 'wamid.ZZTEST1', sentAt: new Date() } });
    const st = (status, extra = {}) => wrap({ statuses: [{ id: 'wamid.ZZTEST1', status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: E164, ...extra }] });
    r = await hook(st('delivered'), false);
    check('POST with a bad signature -> 403', r.code === 403);
    let row = await prisma.candidateMessage.findUnique({ where: { id: msg.id } });
    check('bad signature changed nothing', row.status === 'SENT');
    r = await hook(st('delivered'));
    row = await prisma.candidateMessage.findUnique({ where: { id: msg.id } });
    check('delivered tick -> DELIVERED', r.code === 200 && row.status === 'DELIVERED' && /Delivered/.test(row.statusDetail), JSON.stringify([r.code, row.status, row.statusDetail]));
    await hook(st('read'));
    row = await prisma.candidateMessage.findUnique({ where: { id: msg.id } });
    check('read tick -> READ', row.status === 'READ');
    await hook(st('sent'));
    row = await prisma.candidateMessage.findUnique({ where: { id: msg.id } });
    check('a late "sent" does not undo READ', row.status === 'READ');
    await hook(st('failed', { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is incapable of receiving this message' } }] }));
    row = await prisma.candidateMessage.findUnique({ where: { id: msg.id } });
    check('failed tick -> FAILED with Meta words', row.status === 'FAILED' && /131026/.test(row.lastError) && /incapable/.test(row.lastError), row.lastError);
    r = await hook(wrap({ contacts: [{ profile: { name: 'Zz' }, wa_id: E164 }], messages: [{ from: E164, id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Yes I am interested' } }] }));
    const inbound = await prisma.candidateMessage.findFirst({ where: { candidateId: cand.id, status: 'RECEIVED' } });
    check('reply stored in the candidate log (RECEIVED)', !!inbound && /interested/.test(inbound.body));
    const win = await prisma.appSetting.findUnique({ where: { key: `wa.window.${E164}` } });
    check('24-hour window opened for that number', !!win);
    const prev = await api('POST', '/messaging/preview', { audience: 'candidates', ids: [cand.id], channels: ['WhatsApp'], kind: 'individual', body: 'Hello {{firstName}}, thanks for replying.' });
    const first = prev.body && prev.body.first;
    check('preview: plain text allowed inside the 24 h window', prev.code === 200 && first && first.status === 'queued', JSON.stringify(prev.body).slice(0, 300));
    r = await hook(wrap({ messages: [{ from: E164, id: 'wamid.IN2', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'STOP' } }] }));
    const prev2 = await api('POST', '/messaging/preview', { audience: 'candidates', ids: [cand.id], channels: ['WhatsApp'], kind: 'individual', body: 'Hello again' });
    check('after STOP: blocked with the reason', prev2.body.first && prev2.body.first.status === 'blocked' && /STOP/.test(prev2.body.first.reason), JSON.stringify(prev2.body.first));
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'msg.optout.' } } });
    const bj = await api('POST', '/messaging/bulk', { audience: 'candidates', ids: [cand.id], channels: ['WhatsApp'], kind: 'bulk', purpose: 'ZZTEST wa bulk', body: 'Hello from bulk', confirmPeople: 1 });
    check('bulk job created', bj.code === 202, JSON.stringify(bj.body).slice(0, 200));
    jobIds.push(bj.body.id);
    let job;
    for (let i = 0; i < 30; i += 1) { await sleep(700); job = (await api('GET', `/messaging/bulk/${bj.body.id}`)).body; if (job && job.status === 'done') break; }
    const rec = job && job.recipients && job.recipients[0];
    check('bulk row sent (test server) with a provider ref', rec && rec.status === 'sent' && rec.providerRef, JSON.stringify(rec));
    await hook(wrap({ statuses: [{ id: rec.providerRef, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: E164 }] }));
    job = (await api('GET', `/messaging/bulk/${bj.body.id}`)).body;
    check('bulk job shows the delivery report', job.recipients[0].delivery === 'DELIVERED' && job.counts.delivered === 1, JSON.stringify([job.recipients[0].delivery, job.counts.delivered]));
    const csv = await (await api('GET', `/messaging/bulk/${bj.body.id}/report.csv`, null, true)).text();
    check('CSV report has the Delivery report column', /Delivery report/.test(csv) && /Delivered/.test(csv));
    let det = await api('GET', '/messaging/channels/detail');
    const wa = det.body.channels.WhatsApp;
    check('Channels tab: WhatsApp webhook + checklist + seen', wa.webhook && /api\/webhooks\/whatsapp/.test(wa.webhook.url) && wa.checks.length >= 5 && wa.checks.find((k) => /calling our webhook/.test(k.label)).ok === true, JSON.stringify(wa.checks));

    // ---- SMS delivery reports ---------------------------------------------------------
    const confS = await api('PUT', '/admin/integrations/sms/configure', { values: {
      'Provider (MSG91 / Fast2SMS / Twilio)': 'MSG91', 'Sender ID (6 chars) / Twilio From number': 'TMLINK', 'API key / Auth token': 'zz-fake-msg91-key',
      'DLT template ID — bulk / general': 'zz-flow-1', 'Delivery-report webhook secret (any text you choose)': DLR } });
    check('SMS configured (fake MSG91)', confS.code === 200, JSON.stringify(confS.body).slice(0, 200));
    const smsMsg = await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'SMS', template: 'MANUAL', trigger: 'Manual', recipient: `+${E164}`, body: 'ZZTEST sms', status: 'SENT', providerRef: 'zzreq-001', sentAt: new Date() } });
    r = await post('/webhooks/sms/msg91?key=wrong', { requestId: 'zzreq-001', telNum: E164, status: '1', event: 'delivered' });
    check('MSG91 report with a wrong key -> 403', r.code === 403);
    r = await post(`/webhooks/sms/msg91?key=${DLR}`, { requestId: 'zzreq-001', telNum: E164, status: '1', event: 'delivered', failureReason: '' });
    row = await prisma.candidateMessage.findUnique({ where: { id: smsMsg.id } });
    check('MSG91 delivered report -> DELIVERED', r.code === 200 && row.status === 'DELIVERED', JSON.stringify([r.code, r.body, row.status]));
    r = await post(`/webhooks/sms/msg91?key=${DLR}`, { requestId: 'zzreq-001', telNum: E164, status: '2', event: 'failed', failureReason: 'Template mismatch' });
    row = await prisma.candidateMessage.findUnique({ where: { id: smsMsg.id } });
    check('MSG91 failed report -> FAILED with the reason', row.status === 'FAILED' && /Template mismatch/.test(row.lastError || ''), JSON.stringify([row.status, row.lastError]));
    const sms2 = await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'SMS', template: 'MANUAL', trigger: 'Manual', recipient: `+${E164}`, body: 'ZZTEST sms2', status: 'SENT', providerRef: 'zzf2s-001', sentAt: new Date() } });
    r = await post(`/webhooks/sms/fast2sms?key=${DLR}`, { request_id: 'zzf2s-001', mobile: PHONE, status: 'delivered', webhook_type: 'status_update' });
    row = await prisma.candidateMessage.findUnique({ where: { id: sms2.id } });
    check('Fast2SMS delivered report -> DELIVERED', row.status === 'DELIVERED', JSON.stringify([r.code, row.status]));
    det = await api('GET', '/messaging/channels/detail');
    const sm = det.body.channels.SMS;
    check('Channels tab: SMS checklist knows delivery reports arrive', sm.checks.find((k) => /reaching us/.test(k.label)).ok === true && /sms\/msg91\?key=/.test(sm.webhook.url), JSON.stringify(sm.webhook));

    // ---- Calls --------------------------------------------------------------------------
    let tel = await api('PUT', '/admin/integrations/telephony/configure', { values: {
      'Provider (Exotel)': 'Exotel', 'Account SID': 'zztest', 'API key': 'zz-key', 'API token': 'zz-token', 'Region (Mumbai or Singapore)': 'Mumbai',
      'Caller ID (your ExoPhone number)': '08000000000', 'Record calls (Yes or No)': 'No', 'Call-result webhook secret (any text you choose)': CALLKEY } });
    check('Telephony configured (fake Exotel)', tel.code === 200, JSON.stringify(tel.body).slice(0, 200));
    const chs = await api('GET', '/messaging/channels');
    check('GET /messaging/channels says calling is ready', chs.body.call && chs.body.call.configured === true && chs.body.call.provider === 'Exotel', JSON.stringify(chs.body.call));
    // the admin has no phone on a profile -> a clear refusal
    const noPhone = await api('POST', '/messaging/call', { audience: 'candidates', id: cand.id });
    check('call without the caller\'s own phone -> clear refusal', noPhone.code === 409 && /phone number/i.test(noPhone.body.error), JSON.stringify(noPhone.body));
    const emp = await prisma.employee.findUnique({ where: { userId: sa.id } });
    let madeEmp = null; let oldPhone = null;
    if (emp) { oldPhone = emp.phone; await prisma.employee.update({ where: { id: emp.id }, data: { phone: '9000000088' } }); } else {
      madeEmp = await prisma.employee.create({ data: { name: 'ZZTEST CallEmp', email: 'zztest.callemp@zzmm-sandbox.in', userId: sa.id, employeeCode: `ZZC${Date.now().toString(36)}`, department: 'Medical', employmentStatus: 'Active', phone: '9000000088' } });
    }
    const call = await api('POST', '/messaging/call', { audience: 'candidates', id: cand.id });
    check('call through TeamLink starts (test server)', call.code === 200 && call.body.ok && /^sandbox-call-/.test(call.body.callSid), JSON.stringify(call.body));
    const crow = await prisma.candidateMessage.findFirst({ where: { candidateId: cand.id, channel: 'Call' } });
    check('call logged on the candidate history', crow && crow.providerRef === call.body.callSid && crow.template === 'CALL_THROUGH');
    r = await post('/webhooks/call/exotel?key=bad', { CallSid: call.body.callSid, Status: 'completed' });
    check('call result with a wrong key -> 403', r.code === 403);
    r = await post(`/webhooks/call/exotel?key=${CALLKEY}`, { CallSid: call.body.callSid, Status: 'completed', ConversationDuration: 134, RecordingUrl: 'https://recordings.example.invalid/r1.mp3' });
    const crow2 = await prisma.candidateMessage.findUnique({ where: { id: crow.id } });
    check('call result -> LOGGED with duration', r.code === 200 && crow2.status === 'LOGGED' && /2 min 14 s/.test(crow2.statusDetail), JSON.stringify([r.code, crow2.status, crow2.statusDetail]));
    r = await post(`/webhooks/call/exotel?key=${CALLKEY}`, { CallSid: call.body.callSid, Status: 'no-answer' });
    const crow3 = await prisma.candidateMessage.findUnique({ where: { id: crow.id } });
    check('a later no-answer report -> FAILED "Not answered"', crow3.status === 'FAILED' && /Not answered/.test(crow3.statusDetail));
    const tst = await api('POST', '/messaging/channels/Call/test');
    check('Check connection (test copy cannot reach Exotel) says so honestly', tst.code === 200 && tst.body.ok === false && /blocks every outside call|could not be reached/i.test(tst.body.message), JSON.stringify(tst.body));
    det = await api('GET', '/messaging/channels/detail');
    check('Channels tab: Call card with checklist', det.body.channels.Call && det.body.channels.Call.configured && det.body.channels.Call.checks.length >= 4);
    if (madeEmp) await prisma.employee.delete({ where: { id: madeEmp.id } }).catch(() => {});
    else if (emp) await prisma.employee.update({ where: { id: emp.id }, data: { phone: oldPhone } });
  } finally {
    if (cand) {
      await prisma.candidateMessage.deleteMany({ where: { candidateId: cand.id } }).catch(() => {});
      await prisma.candidate.delete({ where: { id: cand.id } }).catch((e) => console.log('cand', e.message.split('\n').pop()));
    }
    await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'wa.window.' } }, { key: { startsWith: 'msg.optout.' } }, { key: { startsWith: 'webhook.seen.' } }] } }).catch(() => {});
    const bulk = require(`${L.BACK}/src/utils/bulkMessaging`);
    jobIds.forEach((id) => { try { bulk.removeJob(id); } catch (e) { console.log('rm job', e.message); } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ toValue: { contains: 'ZZTEST' } }, { entityId: { in: jobIds } }] } }).catch(() => {});
    if (sw) await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: sw.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'interview-reminders' } });
    for (const [id, before] of [['whatsapp', beforeWa], ['sms', beforeSms], ['telephony', beforeTel]]) {
      if (before) await prisma.integration.update({ where: { id }, data: { values: before.values, enabled: before.enabled, connected: before.connected, state: before.state, error: before.error, connectedAt: before.connectedAt } });
      else await prisma.integration.update({ where: { id }, data: { values: null, enabled: false, connected: false, state: 'Not Connected', error: null, connectedAt: null } }).catch(() => {});
      await prisma.integrationEvent.deleteMany({ where: { integrationId: id, createdAt: { gt: new Date(Date.now() - 900000) } } }).catch(() => {});
    }
    console.log(JSON.stringify(L.results()));
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
