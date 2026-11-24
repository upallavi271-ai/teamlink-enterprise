// ---------------------------------------------------------------------------
// CRM > CAMPAIGNS (founder 2026-11-02, from the reference CRM: "Campaigns (Email / SMS)"). One message to many leads or
// contacts at once, by EMAIL or WHATSAPP:
//   audience   leads (status, source, rating, city, industry) or contacts (role, account type), and whose: mine / a
//              salesperson / the whole team. A person without an address for the channel, or who opted out, is skipped
//   message    merge fields {first_name} {name} {company} {city} {sender}; email = subject + text with an unsubscribe link;
//              WhatsApp = the text, or an approved template ({{1}} = first name, {{2}} = company)
//   send       "Send me a test" first, then "Send now": one queue on the server, a few a second; every person's result
//              (sent / failed / skipped + why) is kept, and each sent message is written on that person's timeline
// Who: a sales manager / Admin makes and sends campaigns; a salesperson reads them.
// Unsubscribe: /api/crm-public/unsubscribe?t=... (signed) adds the address to CrmOptOut; a person can also be marked by hand.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const DB = require('./schema');
const S = require('./service');

const CHANNELS = ['email', 'whatsapp'];
const MAX_AUDIENCE = 2000;
const GAP_MS = { email: 1200, whatsapp: 2500 };
const log = (...a) => console.log('[crm campaigns]', ...a); // eslint-disable-line no-console

const secret = () => String(process.env.JWT_SECRET || 'teamlink-crm');
const signOf = (v) => crypto.createHmac('sha256', secret()).update(`crm-unsub:${v}`).digest('base64url').slice(0, 22);
const tokenFor = (email) => `${Buffer.from(String(email).toLowerCase()).toString('base64url')}.${signOf(String(email).toLowerCase())}`;
function emailOfToken(t) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig) return null;
  let email; try { email = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const want = signOf(email);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? email : null;
}
const normValue = (channel, v) => (channel === 'email' ? String(v || '').trim().toLowerCase() : S.phone10(v));
async function optedOut(channel, v) {
  const n = normValue(channel, v);
  return !!n && !!(await DB.one('SELECT "id" FROM "CrmOptOut" WHERE "value" = ? AND "channel" = ?', n, channel));
}
async function optOut(channel, v, { reason, byId } = {}) {
  const n = normValue(channel, v);
  if (!n || (channel === 'whatsapp' && n.length < 10)) return false;
  await DB.run('INSERT OR IGNORE INTO "CrmOptOut" ("id", "value", "channel", "reason", "byId", "createdAt") VALUES (?, ?, ?, ?, ?, ?)', S.newId('opt'), n, channel, S.clip(reason, 200), byId || null, DB.nowIso());
  return true;
}

// ---- the audience -------------------------------------------------------------------------------------------------------
function cleanAudience(a = {}) {
  return {
    kind: a.kind === 'contacts' ? 'contacts' : 'leads',
    status: S.clip(a.status, 40), source: S.clip(a.source, 60), rating: S.clip(a.rating, 10), city: S.clip(a.city, 60), industry: S.clip(a.industry, 60),
    role: S.clip(a.role, 40), accountKind: ['Prospect', 'Client'].includes(a.accountKind) ? a.accountKind : null,
    owner: S.clip(a.owner, 60),
    segmentId: S.clip(a.segmentId, 60), // CRM wave B: a saved, self-updating segment (crm/b/marketing.js) instead of the filters
  };
}
async function audienceRows(user, aud) {
  if (aud && aud.segmentId) return require('./b/marketing').segmentAudience(user, aud.segmentId); // eslint-disable-line global-require
  const r = S.roleOf(user);
  const where = []; const params = [];
  const ownerCol = 'x."ownerId"';
  if (!S.seesAll(r)) { where.push(`${ownerCol} = ?`); params.push(user.id); } else if (aud.owner) { where.push(`${ownerCol} = ?`); params.push(aud.owner); }
  if (aud.kind === 'leads') {
    if (aud.status === 'open' || !aud.status) where.push('x."status" NOT IN (\'Converted\', \'Junk\')');
    else if (aud.status !== 'all') { where.push('x."status" = ?'); params.push(aud.status); }
    if (aud.source) { where.push('x."source" = ?'); params.push(aud.source); }
    if (aud.rating) { where.push('x."rating" = ?'); params.push(aud.rating); }
    if (aud.city) { where.push('x."city" LIKE ?'); params.push(`%${aud.city}%`); }
    if (aud.industry) { where.push('x."industry" LIKE ?'); params.push(`%${aud.industry}%`); }
    return DB.all(`SELECT x."id", x."contactName" AS "name", x."company", x."email", x."phone", x."city" FROM "CrmLead" x WHERE ${where.length ? where.join(' AND ') : '1=1'} LIMIT ${MAX_AUDIENCE + 1}`, ...params);
  }
  if (aud.role) { where.push('x."role" = ?'); params.push(aud.role); }
  if (aud.accountKind) { where.push('a."kind" = ?'); params.push(aud.accountKind); }
  if (aud.city) { where.push('a."city" LIKE ?'); params.push(`%${aud.city}%`); }
  if (aud.industry) { where.push('a."industry" LIKE ?'); params.push(`%${aud.industry}%`); }
  return DB.all(`SELECT x."id", x."name", a."name" AS "company", x."email", x."phone", a."city", x."accountId" FROM "CrmContact" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.length ? where.join(' AND ') : '1=1'} LIMIT ${MAX_AUDIENCE + 1}`, ...params);
}
async function preview(user, { channel, audience } = {}) {
  const ch = CHANNELS.includes(channel) ? channel : 'email';
  const aud = cleanAudience(audience);
  const rows = await audienceRows(user, aud);
  let reachable = 0; let noAddress = 0; let out = 0;
  for (const x of rows.slice(0, MAX_AUDIENCE)) {
    const addr = ch === 'email' ? x.email : x.phone;
    if (!addr || (ch === 'whatsapp' && S.phone10(addr).length < 10)) { noAddress += 1; continue; } // eslint-disable-line no-continue
    if (await optedOut(ch, addr)) { out += 1; continue; } // eslint-disable-line no-await-in-loop, no-continue
    reachable += 1;
  }
  return S.okBody({ total: Math.min(rows.length, MAX_AUDIENCE), tooMany: rows.length > MAX_AUDIENCE, reachable, noAddress, optedOut: out, sample: rows.slice(0, 5).map((x) => ({ name: x.name, company: x.company })) });
}

// ---- the message ------------------------------------------------------------------------------------------------------------
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
function merge(text, x, sender) {
  return String(text || '')
    .replace(/\{first_name\}/gi, firstName(x.name) || 'there')
    .replace(/\{name\}/gi, x.name || 'there')
    .replace(/\{company\}/gi, x.company || 'your company')
    .replace(/\{city\}/gi, x.city || '')
    .replace(/\{sender\}/gi, sender || '');
}
function unsubscribeLine(email) {
  const base = (process.env.PUBLIC_API_URL || process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  // CRM wave B: the preference centre (crm/b/marketing.js) next to the unsubscribe link - which topics, which channels, or nothing
  const prefs = base ? `\nChoose what you get from us: ${require('./b/marketing').prefsLink(email)}` : ''; // eslint-disable-line global-require
  return base ? `\n\n--\nNot interested? Unsubscribe: ${base}/api/crm-public/unsubscribe?t=${tokenFor(email)}${prefs}` :'\n\n--\nNot interested? Reply "unsubscribe" and we will not write again.';
}

function cleanCampaign(body) {
  const name = S.clip(body.name, 120);
  if (!name) return { error: 'Give the campaign a name.' };
  const channel = CHANNELS.includes(body.channel) ? body.channel : null;
  if (!channel) return { error: 'Pick Email or WhatsApp.' };
  const text = S.clip(body.body, 5000);
  if (!text) return { error: 'Write the message.' };
  const subject = S.clip(body.subject, 200);
  if (channel === 'email' && !subject) return { error: 'Write the email subject.' };
  return { data: { name, channel, subject: channel === 'email' ? subject : null, body: text, waTemplate: channel === 'whatsapp' ? S.clip(body.waTemplate, 120) : null, waLanguage: channel === 'whatsapp' ? (S.clip(body.waLanguage, 10) || 'en') : null, audienceJson: JSON.stringify(cleanAudience(body.audience)) } };
}

async function list(user, q = {}) {
  const FL = require('./listFilters'); // eslint-disable-line global-require
  const where = ['1=1']; const params = [];
  FL.campaign(q, where, params);
  const rows = await DB.all(`SELECT * FROM "CrmCampaign" WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT ${FL.any(q) ? 20000 : 200}`, ...params);
  return S.okBody({ rows: rows.map((c) => ({ ...c, audience: JSON.parse(c.audienceJson || '{}') })), canEdit: S.mayAssign(S.roleOf(user)) });
}
async function save(user, id, body = {}) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Campaigns are made and sent by a Sales manager or an Admin.');
  const c = cleanCampaign(body);
  if (c.error) return S.fail(400, c.error);
  const now = DB.nowIso();
  if (id) {
    const cur = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id).slice(0, 60));
    if (!cur) return S.fail(404, 'This campaign is not there.');
    if (cur.status !== 'Draft') return S.fail(400, 'This campaign was sent already; make a copy to change it.');
    return S.okBody({ ok: true, campaign: await S.update('CrmCampaign', cur.id, { ...c.data, updatedAt: now }) });
  }
  const campaign = await S.insert('CrmCampaign', { id: S.newId('camp'), ...c.data, status: 'Draft', ownerId: user.id, ownerName: user.name || null, createdById: user.id, createdAt: now, updatedAt: now });
  return S.okBody({ ok: true, campaign });
}
async function detail(user, id) {
  const c = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c) return S.fail(404, 'This campaign is not there.');
  const r = S.roleOf(user);
  const own = S.seesAll(r) ? '' : ' AND "recordId" IN (SELECT "id" FROM "CrmLead" WHERE "ownerId" = ? UNION SELECT "id" FROM "CrmContact" WHERE "ownerId" = ?)';
  const recipients = await DB.all(`SELECT * FROM "CrmCampaignRecipient" WHERE "campaignId" = ?${own} ORDER BY CASE "status" WHEN 'failed' THEN 0 WHEN 'queued' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END LIMIT 2500`, c.id, ...(own ? [user.id, user.id] : []));
  return S.okBody({ campaign: { ...c, audience: JSON.parse(c.audienceJson || '{}') }, recipients, canEdit: S.mayAssign(r) });
}

// ---- sending -----------------------------------------------------------------------------------------------------------------
async function deliver(c, x, sender) {
  if (c.channel === 'email') {
    const text = merge(c.body, x, sender) + unsubscribeLine(x.toAddr);
    const html = x.id ? await require('./b/mail').campaignHtml(c, x, text).catch(() => null) : null; // eslint-disable-line global-require -- opens / clicks when tracking is on (crm/b/mail.js)
    return require('../utils/mailer').sendMail({ to: x.toAddr, subject: merge(c.subject, x, sender), text, ...(html ? { html } : {}) }); // eslint-disable-line global-require
  }
  const text = merge(c.body, x, sender);
  return require('../channels/send').sendWhatsApp({ // eslint-disable-line global-require
    to: x.toAddr, text, kind: 'bulk',
    template: c.waTemplate ? { name: c.waTemplate, language: c.waLanguage || 'en', vars: [firstName(x.name) || 'there', x.company || ''] } : undefined,
    meta: { audience: 'crm', personName: x.name, purpose: `CRM campaign: ${c.name}`, campaignId: c.id },
  });
}

async function testSend(user, id, { to } = {}) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Campaigns are made and sent by a Sales manager or an Admin.');
  const c = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c) return S.fail(404, 'This campaign is not there.');
  const addr = S.clip(to, 200);
  if (!addr) return S.fail(400, c.channel === 'email' ? 'Write your email address for the test.' : 'Write your WhatsApp number for the test.');
  const out = await deliver(c, { toAddr: c.channel === 'email' ? addr : S.phone10(addr), name: user.name, company: 'Test Company Pvt Ltd', city: 'Hyderabad' }, user.name);
  if (!out || !out.ok) return S.fail(502, `The test was not sent: ${(out && out.error) || 'the channel is not set up'}.`);
  return S.okBody({ ok: true, sentTo: addr });
}

const running = new Set();
async function runCampaign(id, sender) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const c = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', id);
    for (;;) {
      const x = await DB.one('SELECT * FROM "CrmCampaignRecipient" WHERE "campaignId" = ? AND "status" = \'queued\' LIMIT 1', id); // eslint-disable-line no-await-in-loop
      if (!x) break;
      const cur = await DB.one('SELECT "status" FROM "CrmCampaign" WHERE "id" = ?', id); // eslint-disable-line no-await-in-loop
      if (!cur || cur.status === 'Cancelled') break;
      let res;
      try { res = await deliver(c, x, sender); } catch (e) { res = { ok: false, error: e.message }; } // eslint-disable-line no-await-in-loop
      const now = DB.nowIso();
      if (res && res.ok) {
        await DB.run('UPDATE "CrmCampaignRecipient" SET "status" = \'sent\', "sentAt" = ?, "error" = NULL WHERE "id" = ?', now, x.id); // eslint-disable-line no-await-in-loop
        await DB.run('UPDATE "CrmCampaign" SET "sent" = "sent" + 1, "updatedAt" = ? WHERE "id" = ?', now, id); // eslint-disable-line no-await-in-loop
        // on the person's timeline
        const link = x.kind === 'lead' ? { leadId: x.recordId } : { contactId: x.recordId, accountId: ((await S.getRow('contact', x.recordId)) || {}).accountId || null }; // eslint-disable-line no-await-in-loop
        await S.insert('CrmActivity', { id: S.newId('act'), kind: c.channel === 'email' ? 'email' : 'whatsapp', subject: `Campaign: ${c.name}`, note: c.channel === 'email' ? c.subject : null, at: now, ...link, byId: c.createdById, byName: sender || null, createdAt: now }); // eslint-disable-line no-await-in-loop
      } else {
        await DB.run('UPDATE "CrmCampaignRecipient" SET "status" = \'failed\', "error" = ? WHERE "id" = ?', String((res && res.error) || 'not sent').slice(0, 300), x.id); // eslint-disable-line no-await-in-loop
        await DB.run('UPDATE "CrmCampaign" SET "failed" = "failed" + 1, "updatedAt" = ? WHERE "id" = ?', now, id); // eslint-disable-line no-await-in-loop
      }
      await new Promise((res2) => { setTimeout(res2, process.env.TEST_MODE ? 20 : GAP_MS[c.channel]); }); // eslint-disable-line no-await-in-loop
    }
    const end = await DB.one('SELECT "status" FROM "CrmCampaign" WHERE "id" = ?', id);
    if (end && end.status === 'Sending') await DB.run('UPDATE "CrmCampaign" SET "status" = \'Sent\', "finishedAt" = ? WHERE "id" = ?', DB.nowIso(), id);
  } catch (e) { log('campaign', id, 'stopped:', e.message); } finally { running.delete(id); }
}

async function sendNow(user, id) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Campaigns are made and sent by a Sales manager or an Admin.');
  const c = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c) return S.fail(404, 'This campaign is not there.');
  if (c.status !== 'Draft') return S.fail(400, `This campaign is ${c.status.toLowerCase()} already.`);
  const rows = await audienceRows(user, JSON.parse(c.audienceJson || '{}'));
  if (rows.length > MAX_AUDIENCE) return S.fail(400, `The audience has more than ${MAX_AUDIENCE} people; narrow it down.`);
  const aud = JSON.parse(c.audienceJson || '{}');
  let total = 0; let skipped = 0; const seen = new Set();
  for (const x of rows) {
    const raw = c.channel === 'email' ? x.email : x.phone;
    const addr = c.channel === 'email' ? String(raw || '').trim().toLowerCase() : S.phone10(raw);
    let status = 'queued'; let error = null;
    if (!addr || (c.channel === 'whatsapp' && addr.length < 10)) { status = 'skipped'; error = c.channel === 'email' ? 'no email' : 'no mobile number'; } else if (seen.has(addr)) { status = 'skipped'; error = 'same address twice'; } else if (await optedOut(c.channel, addr)) { status = 'skipped'; error = 'opted out'; } else if (await require('./b/marketing').prefBlocks(c.channel, addr, c.topic).catch(() => false)) { status = 'skipped'; error = 'not for this topic / channel (their preferences)'; } // eslint-disable-line no-await-in-loop, global-require
    if (addr) seen.add(addr);
    // eslint-disable-next-line no-await-in-loop
    await DB.run('INSERT INTO "CrmCampaignRecipient" ("id", "campaignId", "kind", "recordId", "name", "company", "toAddr", "status", "error") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('rcp'), c.id, aud.kind === 'contacts' ? 'contact' : 'lead', x.id, x.name || null, x.company || null, addr || null, status, error);
    total += 1; if (status === 'skipped') skipped += 1;
  }
  if (total === skipped) {
    await DB.run('DELETE FROM "CrmCampaignRecipient" WHERE "campaignId" = ?', c.id);
    return S.fail(400, total ? 'Nobody in this audience can be reached (no address, or they opted out).' : 'Nobody matches this audience.');
  }
  const now = DB.nowIso();
  await S.update('CrmCampaign', c.id, { status: 'Sending', total, skipped, startedAt: now, updatedAt: now });
  await S.audit(user, 'CRM campaign sent', 'CrmCampaign', c.id, `${c.name}: ${total - skipped} to send by ${c.channel}, ${skipped} skipped`);
  runCampaign(c.id, user.name || '').catch(() => {});
  return S.okBody({ ok: true, total, skipped, toSend: total - skipped });
}

async function cancel(user, id) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Campaigns are made and sent by a Sales manager or an Admin.');
  const c = await DB.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c) return S.fail(404, 'This campaign is not there.');
  if (c.status === 'Draft') { await DB.run('DELETE FROM "CrmCampaign" WHERE "id" = ?', c.id); return S.okBody({ ok: true, deleted: true }); }
  if (c.status !== 'Sending') return S.fail(400, 'This campaign has finished.');
  const now = DB.nowIso();
  await DB.run('UPDATE "CrmCampaignRecipient" SET "status" = \'skipped\', "error" = \'campaign stopped\' WHERE "campaignId" = ? AND "status" = \'queued\'', c.id);
  const left = await DB.one('SELECT COUNT(*) AS "n" FROM "CrmCampaignRecipient" WHERE "campaignId" = ? AND "status" = \'skipped\'', c.id);
  await S.update('CrmCampaign', c.id, { status: 'Cancelled', skipped: left.n, finishedAt: now, updatedAt: now });
  return S.okBody({ ok: true });
}

// Campaigns still "Sending" when the server restarted carry on.
async function resume() {
  const rows = await DB.all('SELECT "id", "ownerName" FROM "CrmCampaign" WHERE "status" = \'Sending\'').catch(() => []);
  rows.forEach((c) => runCampaign(c.id, c.ownerName || '').catch(() => {}));
}

// A person marked "do not contact" by hand (from a lead or a contact).
async function markOptOut(user, { channel, value, reason } = {}) {
  if (!S.mayEdit(S.roleOf(user))) return S.fail(403, 'Your role can read the CRM but not change it.');
  if (!CHANNELS.includes(channel)) return S.fail(400, 'Pick email or WhatsApp.');
  const ok = await optOut(channel, value, { reason: reason || 'marked in the CRM', byId: user.id });
  if (!ok) return S.fail(400, 'That address does not look right.');
  return S.okBody({ ok: true });
}

module.exports = { list, save, detail, preview, testSend, sendNow, cancel, resume, markOptOut, optOut, optedOut, emailOfToken, tokenFor, merge, unsubscribeLine };
