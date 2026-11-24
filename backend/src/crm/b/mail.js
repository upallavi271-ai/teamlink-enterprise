// ---------------------------------------------------------------------------
// CRM WAVE B - EMAIL (06.02 06.03 06.04 06.06 06.08 06.09 06.10 06.11 06.12)
//   templates     one-to-one email / WhatsApp / SMS templates with merge fields; mine or shared with the team (a Sales manager shares)
//   signature     each person's own signature, put under every CRM email they send (and the company name in the HTML copy)
//   tracking      opens (1-pixel image) and clicks (links through TeamLink once) of CRM emails and campaign emails; the timeline line
//                 of the mail says "Opened 2 times · 1 link clicked". OFF until an Admin switches "Email open and click tracking" on.
//   send later    an email / WhatsApp from a record, or a whole campaign, waits in CrmMailQueue and goes at its time (switch "Send later")
//   mail sync     every mail read from a connected mailbox is matched to a record: the shared IMAP inbox (Administration > Integrations >
//                 Shared Inbox), each person's own IMAP mailbox (Outreach tools > My mailbox) and Gmail / Outlook connected with OAuth.
//                 From a customer -> "Replied on Email" on their record; from one of us to a customer (sent outside TeamLink, or BCC'd to
//                 the CRM address) -> "Email sent (logged)". Read once (CrmMailLog). Switch "Read the connected mailboxes".
//   team inbox    customer mail that reaches the team mailbox (sales@ ...) is a card: assign, reply, link to a record, done
//   bounces       a bounce report read from a mailbox, or sent by the mail provider's webhook, is recorded; a hard bounce (5.x.x) or the
//                 third soft one in 30 days puts the address on the suppression list (CrmOptOut) - nothing is mailed to it again
//   documents     a proposal opened from its link, or a deal file shared by link, is written on the deal (who / when / how often)
// ---------------------------------------------------------------------------
const C = require('./common');

const { S, B, clip, esc, lower, json } = C;
const CHANNELS = ['email', 'whatsapp', 'sms'];

// ================================================================== 06.03 templates
const MERGE_HELP = ['{first_name}', '{name}', '{company}', '{city}', '{deal}', '{value}', '{owner}', '{sender}', '{my_phone}', '{my_email}', '{today}'];
async function templates(user, { channel } = {}) {
  const rows = await B.all(`SELECT * FROM "CrmMailTemplate" WHERE ("shared" = 1 OR "ownerId" = ?)${CHANNELS.includes(channel) ? ' AND "channel" = ?' : ''} ORDER BY "shared" DESC, "uses" DESC, "name" COLLATE NOCASE LIMIT 300`, user.id, ...(CHANNELS.includes(channel) ? [channel] : []));
  return S.okBody({ templates: rows.map((t) => ({ ...t, mine: t.ownerId === user.id, canEdit: t.ownerId === user.id || C.isManager(user) })), mergeFields: MERGE_HELP });
}
async function saveTemplate(user, id, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const name = clip(body.name, 120); const text = clip(body.body, 8000);
  const channel = CHANNELS.includes(body.channel) ? body.channel : 'email';
  if (!name) return S.fail(400, 'Give the template a name.');
  if (!text) return S.fail(400, 'Write the message of the template.');
  const subject = channel === 'email' ? clip(body.subject, 200) : null;
  if (channel === 'email' && !subject) return S.fail(400, 'Write the subject of the template.');
  const shared = body.shared === true && C.isManager(user) ? 1 : 0; // only a Sales manager / Admin shares a template with the whole team
  const now = B.nowIso();
  if (id) {
    const t = await B.one('SELECT * FROM "CrmMailTemplate" WHERE "id" = ?', String(id).slice(0, 60));
    if (!t || !(t.ownerId === user.id || C.isManager(user))) return S.fail(404, 'This template is not there, or it is not yours.');
    await B.run('UPDATE "CrmMailTemplate" SET "name" = ?, "channel" = ?, "subject" = ?, "body" = ?, "shared" = ?, "updatedAt" = ? WHERE "id" = ?', name, channel, subject, text, body.shared === undefined ? t.shared : shared, now, t.id);
    return S.okBody({ ok: true, template: await B.one('SELECT * FROM "CrmMailTemplate" WHERE "id" = ?', t.id) });
  }
  const row = { id: C.newId('mtpl'), name, channel, subject, body: text, shared, ownerId: user.id, byId: user.id, byName: user.name || null, createdAt: now, updatedAt: now };
  await B.run('INSERT INTO "CrmMailTemplate" ("id","name","channel","subject","body","shared","ownerId","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(row));
  return S.okBody({ ok: true, template: row });
}
async function removeTemplate(user, id) {
  const t = await B.one('SELECT * FROM "CrmMailTemplate" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!t || !(t.ownerId === user.id || C.isManager(user))) return S.fail(404, 'This template is not there, or it is not yours.');
  await B.run('DELETE FROM "CrmMailTemplate" WHERE "id" = ?', t.id);
  return S.okBody({ ok: true });
}
// the facts a template is filled with, for one record
async function factsFor(user, kind, row) {
  const f = { name: '', company: '', city: '', deal: '', value: '', owner: row.ownerName || '' };
  if (kind === 'lead') Object.assign(f, { name: row.contactName || '', company: row.company || '', city: row.city || '', value: row.expectedValue ? `Rs ${Number(row.expectedValue).toLocaleString('en-IN')}` : '' });
  if (kind === 'contact') { const a = row.accountId ? await S.getRow('account', row.accountId) : null; Object.assign(f, { name: row.name || '', company: (a && a.name) || '', city: (a && a.city) || '' }); }
  if (kind === 'account') { const c = await B.one('SELECT "name" FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 ELSE 1 END LIMIT 1', row.id); Object.assign(f, { name: (c && c.name) || '', company: row.name || '', city: row.city || '' }); }
  if (kind === 'deal') {
    const a = row.accountId ? await S.getRow('account', row.accountId) : null;
    const c = row.contactId ? await S.getRow('contact', row.contactId) : null;
    Object.assign(f, { name: (c && c.name) || '', company: (a && a.name) || '', city: (a && a.city) || '', deal: row.title || '', value: row.value ? `Rs ${Number(row.value).toLocaleString('en-IN')}` : '' });
  }
  const own = await require('../../utils/messageChannels').ownContact(user).catch(() => ({})); // eslint-disable-line global-require
  return { ...f, sender: user.name || '', myPhone: own.phone || '', myEmail: own.email || user.email || '' };
}
function fill(text, f) {
  const first = String(f.name || '').trim().split(/\s+/)[0] || 'there';
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/');
  return String(text || '').replace(/\{first_name\}/gi, first).replace(/\{name\}/gi, f.name || 'there').replace(/\{company\}/gi, f.company || 'your company')
    .replace(/\{city\}/gi, f.city || '').replace(/\{deal\}/gi, f.deal || '').replace(/\{value\}/gi, f.value || '').replace(/\{owner\}/gi, f.owner || f.sender || '')
    .replace(/\{sender\}/gi, f.sender || '').replace(/\{my_phone\}/gi, f.myPhone || '').replace(/\{my_email\}/gi, f.myEmail || '').replace(/\{today\}/gi, today);
}
async function renderTemplate(user, id, { kind, recordId } = {}) {
  const t = await B.one('SELECT * FROM "CrmMailTemplate" WHERE "id" = ? AND ("shared" = 1 OR "ownerId" = ?)', String(id || '').slice(0, 60), user.id);
  if (!t) return S.fail(404, 'This template is not there.');
  const row = await C.visible(user, kind, recordId);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const f = await factsFor(user, kind, row);
  await B.run('UPDATE "CrmMailTemplate" SET "uses" = "uses" + 1 WHERE "id" = ?', t.id);
  return S.okBody({ channel: t.channel, subject: t.subject ? fill(t.subject, f) : null, text: fill(t.body, f) });
}

// ================================================================== 06.10 signature
async function signatureOf(userId) { const r = await B.one('SELECT "text" FROM "CrmMailSignature" WHERE "userId" = ?', userId); return (r && r.text) || ''; }
async function getSignature(user) { return S.okBody({ text: await signatureOf(user.id), suggestion: `${user.name || ''}\nTeamLink Consultants` }); }
async function saveSignature(user, { text } = {}) {
  const v = clip(text, 1500) || '';
  await B.run('INSERT INTO "CrmMailSignature" ("userId","text","updatedAt") VALUES (?,?,?) ON CONFLICT("userId") DO UPDATE SET "text" = excluded."text", "updatedAt" = excluded."updatedAt"', user.id, v, B.nowIso());
  return S.okBody({ ok: true, text: v });
}
function withSignature(text, sig) {
  const s = String(sig || '').trim();
  if (!s || String(text).includes(s)) return text;
  return `${String(text).replace(/\s+$/, '')}\n\n-- \n${s}`;
}

// ================================================================== 06.04 open / click tracking
const PRIVACY = 'TeamLink can see when this email is opened and which links are clicked.';
const BOT_UA = /bot|crawl|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urlscan/i;
const QUIET_MS = () => (process.env.TEST_MODE ? 0 : 3000);
async function wrapHtml(text, { kind, recordId, campaignId, to, subject, byId, footer } = {}) {
  const base = C.baseUrl();
  if (!base) return null;
  const token = C.token(16);
  const links = [];
  const body = esc(text).replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    const url = m.replace(/&amp;/g, '&');
    const i = links.push(url) - 1;
    return `<a href="${base}/api/crm-public/b/t/c/${token}/${i}">${m}</a>`;
  }).replace(/\r?\n/g, '<br>');
  await B.run('INSERT INTO "CrmMailTrack" ("token","kind","recordId","campaignId","toAddr","subject","links","sentAt","byId") VALUES (?,?,?,?,?,?,?,?,?)', token, kind || null, recordId || null, campaignId || null, clip(to, 200), clip(subject, 300), JSON.stringify(links), B.nowIso(), byId || null);
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">${body}${footer ? `<p style="margin-top:16px;font-size:12px;color:#374151">${esc(footer)}</p>` : ''}<p style="margin-top:14px;font-size:11px;color:#6b7280">${esc(PRIVACY)}</p><img src="${base}/api/crm-public/b/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0"></div>`;
  return { html, token };
}
const stamp = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
async function writeOnActivity(t) {
  if (!t.activityId) return;
  const opens = Number(t.openCount) || 0; const clicks = Number(t.clickCount) || 0;
  const detail = `Opened ${opens} time${opens === 1 ? '' : 's'}${t.lastOpenAt ? `, last ${stamp(t.lastOpenAt)}` : ''}${clicks ? ` · ${clicks} link click${clicks === 1 ? '' : 's'}` : ''}`;
  await B.run('UPDATE "CrmActivity" SET "deliveryStatus" = ?, "deliveryDetail" = ? WHERE "id" = ?', clicks ? 'Clicked' : 'Opened', detail, t.activityId);
}
async function trackRow(token) { return B.one('SELECT * FROM "CrmMailTrack" WHERE "token" = ?', String(token || '').slice(0, 40)); }
async function recordOpen(token, ua) {
  const r = await trackRow(token);
  if (!r || BOT_UA.test(String(ua || ''))) return false;
  if (Date.now() - Date.parse(r.sentAt) < QUIET_MS()) return false; // a scanner fetching it the moment it was sent
  const t = B.nowIso();
  const first = !r.firstOpenAt;
  await B.run('UPDATE "CrmMailTrack" SET "openCount" = "openCount" + 1, "firstOpenAt" = COALESCE("firstOpenAt", ?), "lastOpenAt" = ? WHERE "token" = ?', t, t, r.token);
  const n = await trackRow(r.token);
  await writeOnActivity(n);
  if (first && r.byId && r.kind) await C.notify([r.byId], `Email opened: ${r.subject || ''}`.slice(0, 170), `${r.toAddr || 'The customer'} opened your email. Open: /crm/${r.kind === 'contact' ? 'accounts' : `${r.kind}s`}?open=${r.kind}:${r.recordId}`, `crm-b-open|${r.token}`);
  return true;
}
async function recordClick(token, i, { ua, method } = {}) {
  const r = await trackRow(token);
  if (!r) return null;
  const url = json(r.links, [])[Number(i)];
  if (!url) return null;
  if (method !== 'HEAD' && !BOT_UA.test(String(ua || '')) && Date.now() - Date.parse(r.sentAt) >= QUIET_MS()) {
    const t = B.nowIso();
    await B.run('UPDATE "CrmMailTrack" SET "clickCount" = "clickCount" + 1, "firstClickAt" = COALESCE("firstClickAt", ?), "lastClickAt" = ?, "firstOpenAt" = COALESCE("firstOpenAt", ?), "lastOpenAt" = COALESCE("lastOpenAt", ?), "openCount" = CASE WHEN "openCount" = 0 THEN 1 ELSE "openCount" END WHERE "token" = ?', t, t, t, t, r.token);
    await writeOnActivity(await trackRow(r.token));
  }
  return url;
}
async function trackingFor(user, kind, id) {
  const row = await C.visible(user, kind, id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const rows = await B.all('SELECT "subject","toAddr","sentAt","openCount","firstOpenAt","lastOpenAt","clickCount","firstClickAt","campaignId" FROM "CrmMailTrack" WHERE "kind" = ? AND "recordId" = ? ORDER BY "sentAt" DESC LIMIT 50', kind, row.id);
  return S.okBody({ on: await B.on('mailTracking'), mails: rows.map((r) => ({ ...r, opened: Number(r.openCount) > 0 })) });
}

// The one hook contact.js calls before an email from a record goes out: the person's signature, and the tracked HTML copy when tracking is on.
async function prepareEmail(user, { kind, id, to, subject, text }) {
  const sig = await signatureOf(user.id);
  const body = withSignature(text, sig);
  let html = null; let token = null;
  if (await B.on('mailTracking')) {
    const w = await wrapHtml(body, { kind, recordId: id, to, subject, byId: user.id }).catch(() => null);
    if (w) { html = w.html; token = w.token; }
  }
  return { text: body, html, token };
}
async function afterEmail(token, activityId, ok) {
  if (!token) return;
  if (!ok) { await B.run('DELETE FROM "CrmMailTrack" WHERE "token" = ?', token); return; }
  await B.run('UPDATE "CrmMailTrack" SET "activityId" = ? WHERE "token" = ?', activityId || null, token);
}
// a campaign email (crm/campaigns.js deliver): the tracked HTML copy, the preference-centre link
async function campaignHtml(c, x, text) {
  if (!(await B.on('mailTracking'))) return null;
  const w = await wrapHtml(text, { kind: x.kind, recordId: x.recordId, campaignId: c.id, to: x.toAddr, subject: c.subject, byId: c.createdById }).catch(() => null);
  return w ? w.html : null;
}

// ================================================================== 06.06 send later
const SCHED_CHANNELS = { Email: 'Email', WhatsApp: 'WhatsApp', SMS: 'SMS' };
async function schedule(user, body = {}) {
  const no = C.needWork(user); if (no) return no;
  if (!(await B.on('sendLater'))) return S.fail(409, 'Send later is switched off. An Admin can switch it on in CRM > Dashboard > Settings (Email, phone and marketing switches).', { switchOff: true });
  const at = new Date(body.sendAt || '');
  if (Number.isNaN(at.getTime())) return S.fail(400, 'Pick the date and time to send it.');
  if (at.getTime() < Date.now() + 60000) return S.fail(400, 'Pick a time at least a minute from now.');
  if (at.getTime() > Date.now() + 60 * 86400000) return S.fail(400, 'Pick a time within the next 60 days.');
  const now = B.nowIso();
  if (body.campaignId) { // a whole campaign, sent at its time by the person who scheduled it
    if (!C.isManager(user)) return S.fail(403, 'Campaigns are made and sent by a Sales manager or an Admin.');
    const c = await B.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(body.campaignId).slice(0, 60));
    if (!c) return S.fail(404, 'This campaign is not there.');
    if (c.status !== 'Draft') return S.fail(400, `This campaign is ${String(c.status).toLowerCase()} already.`);
    const id = C.newId('mq');
    await B.run('INSERT INTO "CrmMailQueue" ("id","what","kind","recordId","channel","subject","sendAt","status","byId","byName","createdAt","updatedAt") VALUES (?,\'campaign\',\'campaign\',?,?,?,?,\'Waiting\',?,?,?,?)', id, c.id, c.channel, c.name, at.toISOString(), user.id, user.name || null, now, now);
    await B.run('UPDATE "CrmCampaign" SET "status" = \'Scheduled\', "updatedAt" = ? WHERE "id" = ?', now, c.id);
    await S.audit(user, 'CRM campaign scheduled', 'CrmCampaign', c.id, `${c.name} at ${at.toISOString()}`);
    return S.okBody({ ok: true, id, sendAt: at.toISOString() });
  }
  const channel = SCHED_CHANNELS[body.channel];
  if (!channel) return S.fail(400, 'Pick Email, WhatsApp or SMS.');
  const row = await C.editable(user, body.kind, body.id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const text = clip(body.text, 4000);
  if (!text) return S.fail(400, 'Write the message first.');
  if (channel === 'Email' && !clip(body.subject, 200)) return S.fail(400, 'Write the subject.');
  const id = C.newId('mq');
  await B.run('INSERT INTO "CrmMailQueue" ("id","what","kind","recordId","channel","toAddr","subject","body","sendAt","status","byId","byName","createdAt","updatedAt") VALUES (?,\'message\',?,?,?,?,?,?,?,\'Waiting\',?,?,?,?)',
    id, body.kind, row.id, channel, clip(body.to, 200), clip(body.subject, 200), text, at.toISOString(), user.id, user.name || null, now, now);
  await C.systemActivity(C.linksFor(body.kind, row), { kind: channel === 'Email' ? 'email' : (channel === 'WhatsApp' ? 'whatsapp' : 'note'), subject: `${channel}${channel === 'SMS' ? ' (SMS)' : ''} scheduled for ${stamp(at.toISOString())}`, note: channel === 'Email' ? clip(body.subject, 200) : text.slice(0, 300), byId: user.id, byName: user.name });
  return S.okBody({ ok: true, id, sendAt: at.toISOString() });
}
async function scheduled(user) {
  const all = C.isManager(user) || S.seesAll(C.role(user));
  const rows = await B.all(`SELECT * FROM "CrmMailQueue" WHERE ${all ? '1=1' : '"byId" = ?'} ORDER BY CASE "status" WHEN 'Waiting' THEN 0 ELSE 1 END, "sendAt" DESC LIMIT 200`, ...(all ? [] : [user.id]));
  return S.okBody({ on: await B.on('sendLater'), rows: rows.map((r) => ({ ...r, mine: r.byId === user.id })) });
}
async function cancelScheduled(user, id) {
  const r = await B.one('SELECT * FROM "CrmMailQueue" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!r || !(r.byId === user.id || C.isManager(user))) return S.fail(404, 'This is not there, or it is not yours.');
  if (r.status !== 'Waiting') return S.fail(400, `It is ${r.status.toLowerCase()} already.`);
  await B.run('UPDATE "CrmMailQueue" SET "status" = \'Cancelled\', "updatedAt" = ? WHERE "id" = ?', B.nowIso(), r.id);
  if (r.what === 'campaign') await B.run('UPDATE "CrmCampaign" SET "status" = \'Draft\' WHERE "id" = ? AND "status" = \'Scheduled\'', r.recordId);
  return S.okBody({ ok: true });
}
async function runQueue({ now = Date.now() } = {}) {
  if (!(await B.on('sendLater'))) return { off: true };
  const due = await B.all('SELECT * FROM "CrmMailQueue" WHERE "status" = \'Waiting\' AND "sendAt" <= ? ORDER BY "sendAt" LIMIT 20', new Date(now).toISOString());
  const out = { sent: 0, failed: 0 };
  const ID = require('../../utils/identity'); // eslint-disable-line global-require
  for (const q of due) {
    /* eslint-disable no-await-in-loop */
    const claimed = await B.run('UPDATE "CrmMailQueue" SET "status" = \'Sending\' WHERE "id" = ? AND "status" = \'Waiting\'', q.id);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    let res;
    try {
      const user = await ID.resolveIdentity(q.byId);
      if (!user || !S.roleOf(user)) res = { status: 403, body: { error: 'The person who scheduled it is no longer on the CRM team.' } };
      else if (q.what === 'campaign') {
        await B.run('UPDATE "CrmCampaign" SET "status" = \'Draft\' WHERE "id" = ? AND "status" = \'Scheduled\'', q.recordId);
        res = await require('../campaigns').sendNow(user, q.recordId); // eslint-disable-line global-require
      }
      else if (q.channel === 'SMS') res = await require('./phone').sendSms(user, { kind: q.kind, id: q.recordId, to: q.toAddr, text: q.body }); // eslint-disable-line global-require
      else res = await require('../contact').send(user, { kind: q.kind, id: q.recordId, channel: q.channel, to: q.toAddr || undefined, subject: q.subject, text: q.body }); // eslint-disable-line global-require
    } catch (e) { res = { status: 500, body: { error: e.message } }; }
    const ok = res && res.status === 200;
    if (q.what === 'campaign' && !ok) await B.run('UPDATE "CrmCampaign" SET "status" = \'Draft\' WHERE "id" = ? AND "status" = \'Scheduled\'', q.recordId);
    await B.run('UPDATE "CrmMailQueue" SET "status" = ?, "result" = ?, "sentAt" = ?, "updatedAt" = ? WHERE "id" = ?', ok ? 'Sent' : 'Failed', ok ? 'Sent' : clip((res && res.body && res.body.error) || 'not sent', 300), ok ? B.nowIso() : null, B.nowIso(), q.id);
    if (ok) out.sent += 1; else out.failed += 1;
    if (!ok && q.byId) await C.notify([q.byId], 'A scheduled message was not sent', `${q.channel} "${q.subject || ''}": ${(res && res.body && res.body.error) || 'not sent'}`, `crm-b-sched|${q.id}`);
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

// ================================================================== 06.12 bounces
async function recordBounce(email, { type = 'hard', code = null, reason = null, source = 'mailbox' } = {}) {
  const e = lower(email);
  if (!C.validEmail(e)) return null;
  const t = type === 'soft' ? 'soft' : 'hard';
  await B.run('INSERT INTO "CrmMailBounce" ("id","email","type","code","reason","source","at") VALUES (?,?,?,?,?,?,?)', C.newId('bnc'), e, t, clip(code, 20), clip(reason, 300), clip(source, 40), B.nowIso());
  const softs = await B.one('SELECT COUNT(*) AS "n" FROM "CrmMailBounce" WHERE "email" = ? AND "type" = \'soft\' AND "at" >= ?', e, new Date(Date.now() - 30 * 86400000).toISOString());
  const suppress = t === 'hard' || Number(softs.n) >= 3;
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  if (suppress) await CMP.optOut('email', e, { reason: `bounced (${t}${code ? ` ${code}` : ''}): ${clip(reason, 120) || 'not delivered'}` });
  const rec = await C.recordByEmail(e);
  if (rec) await C.systemActivity(rec.links, { kind: 'email', subject: `Email bounced (${t === 'hard' ? 'address does not exist' : 'temporary'}): ${e}`, note: [code, reason].filter(Boolean).join(' · ') || null, byName: 'Mail server' });
  return { email: e, type: t, suppressed: suppress, record: rec ? { kind: rec.kind, id: rec.id } : null };
}
async function bounces(user) {
  const no = C.needManager(user); if (no) return no;
  const rows = await B.all('SELECT b.*, (SELECT 1 FROM "CrmOptOut" o WHERE o."value" = b."email" AND o."channel" = \'email\') AS "suppressed" FROM "CrmMailBounce" b ORDER BY b."at" DESC LIMIT 300');
  const list = await B.all('SELECT * FROM "CrmOptOut" WHERE "channel" = \'email\' ORDER BY "createdAt" DESC LIMIT 500');
  return S.okBody({ bounces: rows.map((r) => ({ ...r, suppressed: !!r.suppressed })), suppression: list });
}
async function unsuppress(user, { email } = {}) {
  const no = C.needManager(user); if (no) return no;
  const e = lower(email);
  const n = await B.run('DELETE FROM "CrmOptOut" WHERE "value" = ? AND "channel" = \'email\'', e);
  await S.audit(user, 'CRM email taken off the suppression list', 'CrmOptOut', e, e);
  return S.okBody({ ok: true, removed: Number(n) });
}

// ================================================================== reading one mail (06.02 06.08 06.09 06.12)
function headerBlock(raw) { const s = String(raw || ''); const i = s.search(/\r?\n\r?\n/); return (i < 0 ? s : s.slice(0, i)).replace(/\r?\n[ \t]+/g, ' '); }
function header(raw, name) { const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headerBlock(raw)); return m ? m[1].trim() : ''; }
const addrsOf = (v) => (String(v || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(lower);
function bounceOf(raw, p) {
  const s = String(raw || '');
  const ct = header(s, 'Content-Type');
  const isReport = /report-type=["']?delivery-status/i.test(ct) || /^(mailer-daemon|postmaster)@/i.test(p.from || '') || /^(undeliver|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i.test(p.subject || '');
  if (!isReport) return null;
  const rcpt = (/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i.exec(s) || /Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i.exec(s) || /X-Failed-Recipients:\s*([^\s,]+@[^\s,]+)/i.exec(s) || [])[1];
  if (!rcpt) return null;
  const code = (/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(s) || /\b([45]\.\d\.\d{1,3})\b/.exec(s) || [])[1] || null;
  const diag = (/Diagnostic-Code:\s*(?:smtp;\s*)?([^\r\n]+)/i.exec(s) || [])[1] || null;
  return { email: lower(rcpt), code, type: code && code.startsWith('4') ? 'soft' : 'hard', reason: diag };
}
let teamCache = null; let teamAt = 0;
async function teamAddresses() {
  if (teamCache && Date.now() - teamAt < 60000) return teamCache;
  const SETTINGS = require('../settings'); // eslint-disable-line global-require
  const st = await SETTINGS.load();
  const prisma = require('../../db'); // eslint-disable-line global-require
  const users = await prisma.user.findMany({ where: { OR: [{ id: { in: st.salesTeam.map((m) => m.userId) } }, { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, name: true, email: true } }).catch(() => []);
  const emps = await prisma.employee.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { userId: true, email: true } }).catch(() => []);
  const map = new Map();
  users.forEach((u) => { if (u.email) map.set(lower(u.email), u); });
  emps.forEach((e) => { const u = users.find((x) => x.id === e.userId); if (e.email && u) map.set(lower(e.email), u); });
  teamCache = map; teamAt = Date.now();
  return map;
}
/**
 * One mail from any mailbox -> what it means for the CRM. raw = the RFC 822 text. -> { result, ... }
 * source: imap | mailbox | gmail | outlook | webhook ; mailbox: the address it was read from ; team: it came through the shared team mailbox
 */
async function ingestRaw(raw, { source = 'imap', mailbox = '', team = false } = {}) {
  const imap = require('../../utils/imapInbox'); // eslint-disable-line global-require
  const p = imap.parseMail(raw);
  const messageId = p.messageId || `nomid:${C.sha(String(raw).slice(0, 4000))}`;
  const seen = await B.one('SELECT "result" FROM "CrmMailLog" WHERE "messageId" = ?', messageId);
  if (seen) return { result: 'already read', messageId };
  const log = async (result, extra = {}) => {
    await B.run('INSERT OR IGNORE INTO "CrmMailLog" ("messageId","source","mailbox","direction","fromAddr","toAddrs","subject","at","kind","recordId","activityId","result","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      messageId, source, clip(mailbox, 200), extra.direction || null, clip(p.from, 200), clip(extra.to, 1000), clip(p.subject, 300), p.date.toISOString(), extra.kind || null, extra.recordId || null, extra.activityId || null, result, B.nowIso());
    return { result, messageId, ...extra };
  };
  const bn = bounceOf(raw, p);
  if (bn) { const b = await recordBounce(bn.email, { ...bn, source }); return log(b ? `bounce ${bn.type}` : 'bounce (no address)', { direction: 'in', bounce: b }); }
  if (!p.from) return log('no sender');
  const to = [...new Set([...addrsOf(header(raw, 'To')), ...addrsOf(header(raw, 'Cc')), ...addrsOf(header(raw, 'Bcc')), ...addrsOf(header(raw, 'Delivered-To'))])];
  const team2 = await teamAddresses();
  const st = await B.settings();
  const me = team2.get(lower(p.from));
  if (me) {
    // one of us wrote to a customer from outside TeamLink (or BCC'd the CRM address): logged on every customer it went to
    const hits = [];
    for (const a of to) {
      if (team2.has(a) || a === lower(st.bccAddress) || a === lower(mailbox) || a === lower(st.teamMailbox)) continue; // eslint-disable-line no-continue
      const rec = await C.recordByEmail(a); // eslint-disable-line no-await-in-loop
      if (!rec) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const act = await C.systemActivity(rec.links, { kind: 'email', subject: `Email sent: ${clip(p.subject, 150) || '(no subject)'}`, note: `To ${a}\n\n${clip(p.text, 3500) || ''}`, at: p.date.toISOString(), byId: me.id, byName: `${me.name || a} (logged from ${source === 'imap' ? 'the CRM mailbox' : source})` });
      hits.push({ kind: rec.kind, id: rec.id, activityId: act.id });
    }
    return log(hits.length ? 'logged outgoing' : 'outgoing, no customer', { direction: 'out', to: to.join(', '), kind: hits[0] && hits[0].kind, recordId: hits[0] && hits[0].id, activityId: hits[0] && hits[0].activityId, records: hits });
  }
  if (p.auto) return log('automatic mail');
  const rec = await C.recordByEmail(p.from);
  let act = null;
  // the automatic follow-through reads the shared inbox too and writes "Replied on mail" on a lead (crm/autopilot.js onReply): not twice
  const dup = rec && rec.kind === 'lead' ? await B.one('SELECT 1 AS x FROM "CrmActivity" WHERE "leadId" = ? AND "subject" LIKE \'Replied on mail%\' AND "at" >= ? AND SUBSTR(COALESCE("note", \'\'), 1, 80) = SUBSTR(?, 1, 80)', rec.id, new Date(Date.now() - 30 * 60000).toISOString(), clip(p.text, 1000) || '') : null;
  if (rec && !dup) {
    act = await C.systemActivity(rec.links, { kind: 'email', subject: `Replied on Email: ${clip(p.subject, 150) || '(no subject)'}`, note: clip(p.text, 3800), at: p.date.toISOString(), byName: p.fromName || p.from });
    if (rec.ownerId) await C.notify([rec.ownerId], `${rec.name || p.from} wrote: ${clip(p.subject, 120) || ''}`, `Open: /crm/${rec.kind === 'contact' ? 'accounts' : `${rec.kind}s`}?open=${rec.kind}:${rec.id}`, `crm-b-mail|${messageId}`);
  }
  // the shared team mailbox: customer mail is a card the team handles (assign / reply / done)
  const toTeam = team && (!st.teamMailbox || to.includes(lower(st.teamMailbox)));
  if (toTeam) {
    await B.run('INSERT INTO "CrmTeamMail" ("id","messageId","mailbox","fromAddr","fromName","subject","text","at","status","assigneeId","assigneeName","kind","recordId","createdAt") VALUES (?,?,?,?,?,?,?,?,\'Open\',?,?,?,?,?)',
      C.newId('tm'), messageId, clip(mailbox, 200), clip(p.from, 200), clip(p.fromName, 200), clip(p.subject, 300), clip(p.text, 8000), p.date.toISOString(), rec ? rec.ownerId : null, rec ? rec.ownerName : null, rec ? rec.kind : null, rec ? rec.id : null, B.nowIso());
  }
  return log(rec ? 'logged reply' : (toTeam ? 'team inbox' : 'nobody we know'), { direction: 'in', to: to.join(', '), kind: rec && rec.kind, recordId: rec && rec.id, activityId: act && act.id });
}

// ================================================================== the mailboxes (06.02)
// the shared IMAP inbox + each CRM person's own IMAP mailbox; transport injectable (tests)
async function syncImap({ transport } = {}) {
  const imap = require('../../utils/imapInbox'); // eslint-disable-line global-require
  const prisma = require('../../db'); // eslint-disable-line global-require
  const t = transport || imap.realTransport();
  const out = { mailboxes: 0, read: 0, results: {}, errors: [] };
  const boxes = [];
  const shared = await imap.config().catch(() => ({ configured: false }));
  if (shared.configured) boxes.push({ cfg: shared, key: 'crm.b.ckpt.shared', team: true });
  try {
    const MC = require('../../utils/mkt/core'); // eslint-disable-line global-require
    await MC.ensure();
    const SETTINGS = require('../settings'); // eslint-disable-line global-require
    const ids = (await SETTINGS.load()).salesTeam.map((m) => m.userId);
    const rows = ids.length ? await prisma.$queryRawUnsafe(`SELECT * FROM "MktMailbox" WHERE "userId" IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    rows.forEach((row) => boxes.push({ cfg: { host: row.imapHost, port: Number(row.imapPort) || 993, address: row.address, password: MC.dec(row.secretEnc) || '', username: row.username, configured: true }, key: `crm.b.ckpt.${row.userId}`, team: false }));
  } catch { /* no personal mailboxes */ }
  for (const box of boxes) {
    /* eslint-disable no-await-in-loop */
    out.mailboxes += 1;
    try {
      const ck = await prisma.appSetting.findUnique({ where: { key: box.key } }).catch(() => null);
      const prev = json(ck && ck.value, {});
      const got = await t.fetchNew(box.cfg, { sinceUid: prev.address === box.cfg.address ? prev.uid : null, sinceDate: new Date(Date.now() - 3 * 86400000), limit: 40 });
      for (const m of got.messages || []) {
        out.read += 1;
        const r = await ingestRaw(m.raw, { source: 'imap', mailbox: box.cfg.address, team: box.team });
        out.results[r.result] = (out.results[r.result] || 0) + 1;
      }
      if (got.maxUid != null) await prisma.appSetting.upsert({ where: { key: box.key }, create: { key: box.key, value: JSON.stringify({ address: box.cfg.address, uid: got.maxUid }) }, update: { value: JSON.stringify({ address: box.cfg.address, uid: got.maxUid }) } });
    } catch (e) { out.errors.push(`${box.cfg.address}: ${clip(e.message, 160)}`); }
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

// ---- Gmail / Outlook with OAuth (needs the founder's Google Cloud / Microsoft Entra app: Administration > Integrations)
const PROVIDERS = {
  gmail: {
    integration: 'crm-gmail', label: 'Gmail',
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly openid email',
  },
  outlook: {
    integration: 'crm-outlook', label: 'Outlook / Microsoft 365',
    auth: (tenant) => `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/authorize`, tokenUrl: (tenant) => `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`,
    scope: 'offline_access Mail.Read User.Read',
  },
};
let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); } // tests
async function oauthConfig(provider) {
  const P = PROVIDERS[provider];
  if (!P) return { configured: false, reason: 'Unknown mail service.' };
  const { readConfig } = require('../../utils/integrationStore'); // eslint-disable-line global-require
  const cfg = await readConfig(P.integration).catch(() => ({ values: {} }));
  const v = cfg.values || {};
  const clientId = String(v['Client ID'] || '').trim(); const clientSecret = String(v['Client secret'] || '').trim();
  const tenant = String(v['Tenant ID (Microsoft only)'] || '').trim();
  if (!clientId || !clientSecret) return { configured: false, reason: `${P.label} is not connected yet: an Admin types the OAuth Client ID and secret in Administration > Integrations > ${P.label} (CRM mail).` };
  return { configured: true, clientId, clientSecret, tenant, P };
}
const redirectUri = (provider) => `${C.baseUrl()}/api/crm-public/b/oauth/${provider}`;
async function connectUrl(user, provider) {
  const cfg = await oauthConfig(provider);
  if (!cfg.configured) return S.fail(409, cfg.reason, { notConfigured: true });
  if (!C.baseUrl()) return S.fail(409, 'The server address (APP_BASE_URL) is not set, so the mail service cannot send you back.');
  const state = C.signed('oauth', `${provider}|${user.id}|${Date.now()}`);
  const auth = typeof cfg.P.auth === 'function' ? cfg.P.auth(cfg.tenant) : cfg.P.auth;
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri(provider), response_type: 'code', scope: cfg.P.scope, state, access_type: 'offline', prompt: 'consent' });
  return S.okBody({ url: `${auth}?${q}` });
}
async function tokenCall(cfg, provider, params) {
  const url = typeof cfg.P.tokenUrl === 'function' ? cfg.P.tokenUrl(cfg.tenant) : cfg.P.tokenUrl;
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `the ${cfg.P.label} sign-in did not answer (${r.status})`);
  return j;
}
const emailOfIdToken = (idt) => { try { return lower(JSON.parse(Buffer.from(String(idt).split('.')[1], 'base64url').toString('utf8')).email); } catch { return ''; } };
async function oauthCallback(provider, { code, state } = {}) {
  const v = C.unsign('oauth', state);
  if (!v) return { error: 'This sign-in link is not valid. Start again from the CRM.' };
  const [p, userId, at] = v.split('|');
  if (p !== provider || Date.now() - Number(at) > 15 * 60000) return { error: 'This sign-in took too long. Start again from the CRM.' };
  const cfg = await oauthConfig(provider);
  if (!cfg.configured) return { error: cfg.reason };
  const tok = await tokenCall(cfg, provider, { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: redirectUri(provider) });
  let email = emailOfIdToken(tok.id_token);
  if (!email && provider === 'outlook') {
    const me = await fetchImpl('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json()).catch(() => ({}));
    email = lower(me.mail || me.userPrincipalName);
  }
  const { encryptSecret } = require('../../utils/secrets'); // eslint-disable-line global-require
  const now = B.nowIso();
  await B.run(`INSERT INTO "CrmMailAccount" ("id","userId","provider","email","refreshEnc","accessToken","expiresAt","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,'Connected',?,?)
    ON CONFLICT("userId","provider") DO UPDATE SET "email" = excluded."email", "refreshEnc" = COALESCE(excluded."refreshEnc", "CrmMailAccount"."refreshEnc"), "accessToken" = excluded."accessToken", "expiresAt" = excluded."expiresAt", "status" = 'Connected', "updatedAt" = excluded."updatedAt"`,
  C.newId('macc'), userId, provider, email || null, tok.refresh_token ? encryptSecret(tok.refresh_token) : null, tok.access_token, new Date(Date.now() + (Number(tok.expires_in) || 3000) * 1000).toISOString(), now, now);
  return { ok: true, email, label: cfg.P.label };
}
async function accessFor(acc) {
  if (acc.accessToken && Date.parse(acc.expiresAt || 0) > Date.now() + 60000) return acc.accessToken;
  const cfg = await oauthConfig(acc.provider);
  if (!cfg.configured) throw new Error(cfg.reason);
  const { decryptSecret } = require('../../utils/secrets'); // eslint-disable-line global-require
  const refresh = acc.refreshEnc ? decryptSecret(acc.refreshEnc) : null;
  if (!refresh) throw new Error('Connect the mailbox again (no refresh token).');
  const tok = await tokenCall(cfg, acc.provider, { grant_type: 'refresh_token', refresh_token: refresh });
  await B.run('UPDATE "CrmMailAccount" SET "accessToken" = ?, "expiresAt" = ?, "updatedAt" = ? WHERE "id" = ?', tok.access_token, new Date(Date.now() + (Number(tok.expires_in) || 3000) * 1000).toISOString(), B.nowIso(), acc.id);
  return tok.access_token;
}
async function syncAccount(acc) {
  const at = await accessFor(acc);
  const H = { Authorization: `Bearer ${at}` };
  const raws = [];
  if (acc.provider === 'gmail') {
    const list = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=40&q=${encodeURIComponent('newer_than:3d -in:chats')}`, { headers: H }).then((r) => r.json());
    for (const m of (list.messages || []).slice(0, 40)) {
      if (await B.one('SELECT 1 AS x FROM "CrmMailLog" WHERE "messageId" = ?', `gmail:${m.id}`)) continue; // eslint-disable-line no-await-in-loop, no-continue
      const full = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=raw`, { headers: H }).then((r) => r.json()); // eslint-disable-line no-await-in-loop
      if (full.raw) raws.push({ id: `gmail:${m.id}`, raw: Buffer.from(full.raw, 'base64url').toString('utf8') });
    }
  } else {
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    for (const folder of ['inbox', 'sentitems']) {
      // eslint-disable-next-line no-await-in-loop
      const list = await fetchImpl(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=25&$select=id&$filter=receivedDateTime ge ${since}`, { headers: H }).then((r) => r.json());
      for (const m of list.value || []) {
        if (await B.one('SELECT 1 AS x FROM "CrmMailLog" WHERE "messageId" = ?', `outlook:${m.id}`)) continue; // eslint-disable-line no-await-in-loop, no-continue
        const mime = await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${m.id}/$value`, { headers: H }).then((r) => r.text()); // eslint-disable-line no-await-in-loop
        if (mime) raws.push({ id: `outlook:${m.id}`, raw: mime });
      }
    }
  }
  const results = {};
  for (const m of raws) {
    const r = await ingestRaw(m.raw, { source: acc.provider, mailbox: acc.email || '' }); // eslint-disable-line no-await-in-loop
    results[r.result] = (results[r.result] || 0) + 1;
    // eslint-disable-next-line no-await-in-loop
    await B.run('INSERT OR IGNORE INTO "CrmMailLog" ("messageId","source","mailbox","result","createdAt") VALUES (?,?,?,?,?)', m.id, acc.provider, acc.email || '', `as ${r.messageId}`, B.nowIso());
  }
  await B.run('UPDATE "CrmMailAccount" SET "lastSyncAt" = ?, "lastResult" = ?, "status" = \'Connected\' WHERE "id" = ?', B.nowIso(), JSON.stringify(results).slice(0, 300), acc.id);
  return { read: raws.length, results };
}
async function syncOAuth() {
  const out = { accounts: 0, read: 0, errors: [] };
  for (const acc of await B.all('SELECT * FROM "CrmMailAccount" WHERE "status" != \'Disconnected\'')) {
    out.accounts += 1;
    try { const r = await syncAccount(acc); out.read += r.read; } catch (e) { // eslint-disable-line no-await-in-loop
      out.errors.push(`${acc.email || acc.provider}: ${clip(e.message, 160)}`);
      await B.run('UPDATE "CrmMailAccount" SET "lastSyncAt" = ?, "lastResult" = ?, "status" = \'Error\' WHERE "id" = ?', B.nowIso(), clip(e.message, 300), acc.id); // eslint-disable-line no-await-in-loop
    }
  }
  return out;
}
async function syncAll(opts = {}) {
  if (!(await B.on('mailSync'))) return { off: true };
  const imap = await syncImap(opts).catch((e) => ({ errors: [e.message] }));
  const oauth = await syncOAuth().catch((e) => ({ errors: [e.message] }));
  return { imap, oauth };
}
async function mailAccounts(user) {
  const rows = await B.all('SELECT "id","provider","email","status","lastSyncAt","lastResult" FROM "CrmMailAccount" WHERE "userId" = ?', user.id);
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const cfg = await oauthConfig(p); // eslint-disable-line no-await-in-loop
    out[p] = { label: PROVIDERS[p].label, ready: cfg.configured, reason: cfg.configured ? '' : cfg.reason, account: rows.find((r) => r.provider === p) || null };
  }
  const imap = await require('../../utils/imapInbox').status().catch(() => ({ configured: false })); // eslint-disable-line global-require
  const st = await B.settings();
  return S.okBody({ providers: out, sharedInbox: { configured: !!imap.configured, reason: imap.reason || '' }, syncOn: st.mailSync, bccAddress: st.bccAddress, teamMailbox: st.teamMailbox });
}
async function disconnect(user, provider) {
  await B.run('DELETE FROM "CrmMailAccount" WHERE "userId" = ? AND "provider" = ?', user.id, String(provider || ''));
  return S.okBody({ ok: true });
}

// ================================================================== 06.09 the team inbox
async function teamInbox(user, { status = 'Open', mine } = {}) {
  const r = C.role(user);
  const all = S.seesAll(r);
  const where = []; const params = [];
  if (['Open', 'Done'].includes(status)) { where.push('"status" = ?'); params.push(status); }
  if (!all || mine === '1') { where.push('("assigneeId" = ? OR "assigneeId" IS NULL)'); params.push(user.id); }
  const rows = await B.all(`SELECT * FROM "CrmTeamMail" WHERE ${where.join(' AND ') || '1=1'} ORDER BY "at" DESC LIMIT 200`, ...params);
  const counts = await B.one('SELECT SUM(CASE WHEN "status" = \'Open\' THEN 1 ELSE 0 END) AS "open", SUM(CASE WHEN "status" = \'Open\' AND "assigneeId" IS NULL THEN 1 ELSE 0 END) AS "unassigned" FROM "CrmTeamMail"');
  return S.okBody({ rows, counts: { open: Number(counts.open) || 0, unassigned: Number(counts.unassigned) || 0 }, teamMailbox: (await B.settings()).teamMailbox, canAssign: C.isManager(user) });
}
async function teamMailRow(user, id) {
  const m = await B.one('SELECT * FROM "CrmTeamMail" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!m) return null;
  if (!S.seesAll(C.role(user)) && m.assigneeId && m.assigneeId !== user.id) return null;
  return m;
}
async function teamMailAct(user, id, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const m = await teamMailRow(user, id);
  if (!m) return S.fail(404, 'This mail is not there, or it is not yours.');
  const now = B.nowIso();
  const act = String(body.action || '');
  if (act === 'assign') {
    const to = body.assigneeId ? (await S.ownerOptions()).find((o) => o.id === body.assigneeId) : { id: user.id, name: user.name };
    if (!to) return S.fail(400, 'Pick somebody from the sales team.');
    if (to.id !== user.id && !C.isManager(user)) return S.fail(403, 'Only a Sales manager gives a mail to somebody else. You may take it yourself.');
    await B.run('UPDATE "CrmTeamMail" SET "assigneeId" = ?, "assigneeName" = ? WHERE "id" = ?', to.id, to.name || null, m.id);
    if (to.id !== user.id) await C.notify([to.id], `A mail for you: ${m.subject || ''}`.slice(0, 170), `From ${m.fromAddr}. Open: /crm/followups?tab=inbox`, `crm-b-tm|${m.id}`);
    return S.okBody({ ok: true });
  }
  if (act === 'done' || act === 'reopen') {
    await B.run('UPDATE "CrmTeamMail" SET "status" = ? WHERE "id" = ?', act === 'done' ? 'Done' : 'Open', m.id);
    return S.okBody({ ok: true });
  }
  if (act === 'link') {
    const row = await C.editable(user, body.kind, body.recordId);
    if (!row) return S.fail(404, 'That record is not there, or it is not yours.');
    await B.run('UPDATE "CrmTeamMail" SET "kind" = ?, "recordId" = ? WHERE "id" = ?', body.kind, row.id, m.id);
    await C.systemActivity(C.linksFor(body.kind, row), { kind: 'email', subject: `Replied on Email: ${m.subject || '(no subject)'}`, note: m.text, at: m.at, byName: m.fromName || m.fromAddr });
    return S.okBody({ ok: true });
  }
  if (act === 'reply') {
    const text = clip(body.text, 6000);
    if (!text) return S.fail(400, 'Write the reply first.');
    const own = await require('../../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
    const sig = await signatureOf(user.id);
    const subj = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
    const res = await require('../../utils/messaging').send('Email', { to: m.fromAddr, subject: subj, text: withSignature(text, sig), senderEmail: own.email || undefined, senderName: own.name || user.name, actorUserId: user.id, meta: { audience: 'crm', personName: m.fromName, senderUserId: user.id, purpose: 'CRM team inbox reply' } }); // eslint-disable-line global-require
    if (!res.ok) return S.fail(res.notConfigured ? 409 : 502, res.notConfigured ? `Email is not connected: ${res.error}` : `The reply was not sent: ${res.error || 'the mail server refused it.'}`);
    await B.run('UPDATE "CrmTeamMail" SET "repliedAt" = ?, "repliedBy" = ?, "assigneeId" = COALESCE("assigneeId", ?), "assigneeName" = COALESCE("assigneeName", ?) WHERE "id" = ?', now, user.name || null, user.id, user.name || null, m.id);
    if (m.kind && m.recordId) {
      const row = await S.getRow(m.kind, m.recordId);
      if (row) await C.systemActivity(C.linksFor(m.kind, row), { kind: 'email', subject: `Email sent: ${subj}`, note: `To ${m.fromAddr}\n\n${text}`, byId: user.id, byName: user.name });
    }
    return S.okBody({ ok: true, to: m.fromAddr });
  }
  return S.fail(400, 'Say what to do with the mail.');
}

// ================================================================== 06.11 documents opened
async function docViewed(docKind, docId, req, { what } = {}) {
  let dealId = null; let label = what || '';
  if (docKind === 'proposal') { const p = await B.one('SELECT "dealId", "number" FROM "CrmProposal" WHERE "id" = ?', docId); if (!p) return; dealId = p.dealId; label = label || `proposal ${p.number}`; }
  if (docKind === 'file') { const f = await B.one('SELECT "dealId", "name" FROM "CrmDealFile" WHERE "id" = ?', docId); if (!f) return; dealId = f.dealId; label = label || f.name; }
  const ua = String((req && req.get && req.get('user-agent')) || '');
  if (BOT_UA.test(ua)) return;
  const ip = String((req && (req.ip || req.headers['x-forwarded-for'])) || '').slice(0, 60);
  const prev = await B.one('SELECT "at" FROM "CrmDocView" WHERE "docKind" = ? AND "docId" = ? ORDER BY "at" DESC LIMIT 1', docKind, docId);
  await B.run('INSERT INTO "CrmDocView" ("id","docKind","docId","dealId","what","ip","ua","at") VALUES (?,?,?,?,?,?,?,?)', C.newId('dv'), docKind, docId, dealId, clip(label, 200), ip, clip(ua, 200), B.nowIso());
  if (dealId && (!prev || Date.now() - Date.parse(prev.at) > 6 * 3600e3)) { // one line on the deal per six hours, the count is kept
    const deal = await S.getRow('deal', dealId);
    if (deal) {
      const n = await B.one('SELECT COUNT(*) AS "n" FROM "CrmDocView" WHERE "docKind" = ? AND "docId" = ?', docKind, docId);
      await C.systemActivity({ dealId, accountId: deal.accountId }, { kind: 'note', subject: `The customer opened the ${label}${Number(n.n) > 1 ? ` (${n.n} times so far)` : ''}`, byName: 'Customer' });
      if (!prev && deal.ownerId) await C.notify([deal.ownerId], `${deal.title}: the customer opened the ${label}`, `Open: /crm/deals?open=deal:${deal.id}`, `crm-b-doc|${docKind}|${docId}`);
    }
  }
}
async function docViews(user, dealId) {
  const deal = await C.visible(user, 'deal', dealId);
  if (!deal) return S.fail(404, 'This deal is not there, or it is not yours.');
  const rows = await B.all('SELECT "docKind", "docId", "what", COUNT(*) AS "views", MIN("at") AS "firstAt", MAX("at") AS "lastAt" FROM "CrmDocView" WHERE "dealId" = ? GROUP BY "docKind", "docId", "what" ORDER BY MAX("at") DESC', deal.id);
  return S.okBody({ docs: rows });
}
// a deal file shared by a link that says when it is opened (06.11)
async function shareFile(user, fileId) {
  const f = await B.one('SELECT * FROM "CrmDealFile" WHERE "id" = ?', String(fileId || '').slice(0, 60));
  if (!f) return S.fail(404, 'This file is not there.');
  const deal = await C.editable(user, 'deal', f.dealId);
  if (!deal) return S.fail(404, 'This file is not there, or the deal is not yours.');
  const until = Date.now() + 30 * 86400000;
  const t = C.signed('file', `${f.id}|${until}`);
  return S.okBody({ url: `${C.baseUrl()}/api/crm-public/b/file/${t}`, until: new Date(until).toISOString(), name: f.name });
}
async function fileOfToken(t) {
  const v = C.unsign('file', t);
  if (!v) return null;
  const [id, until] = v.split('|');
  if (Date.now() > Number(until)) return null;
  const f = await B.one('SELECT * FROM "CrmDealFile" WHERE "id" = ?', id);
  if (!f) return null;
  const full = require('../../utils/attachments').resolveStored(f.stored); // eslint-disable-line global-require
  return full ? { ...f, full } : null;
}

module.exports = {
  templates, saveTemplate, removeTemplate, renderTemplate, fill, MERGE_HELP,
  getSignature, saveSignature, signatureOf, withSignature,
  wrapHtml, recordOpen, recordClick, trackingFor, prepareEmail, afterEmail, campaignHtml,
  schedule, scheduled, cancelScheduled, runQueue,
  recordBounce, bounces, unsuppress, bounceOf,
  ingestRaw, syncImap, syncAll, syncOAuth, syncAccount, connectUrl, oauthCallback, mailAccounts, disconnect, setFetch, PROVIDERS,
  teamInbox, teamMailAct,
  docViewed, docViews, shareFile, fileOfToken,
};
