// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 4: PROMOTION CAMPAIGNS THAT NEVER GO TO ANYONE WHO DID NOT AGREE (owner 2026-11-25: "NEVER send unsolicited bulk promotions";
// "show the owner exactly what a campaign will send to whom before anything is sent").
//
//   WHO       only CRM leads whose consent for promotions is recorded and not withdrawn (CrmConsent, purpose "Newsletters and campaigns": given on WhatsApp when the customer answered YES to
//             "Would you like offers and updates?", or recorded by the team in CRM > lead > Consent). Never a stop-listed number (all four lists + the CRM opt-out list), never somebody who
//             got a campaign message in the last N days (default 7), never a lost or junk lead.
//   WHAT      only an APPROVED WhatsApp template (Omni-Channel > Templates, status approved, with its Meta name), never free text, even when the 24-hour window happens to be open. TeamLink
//             fills the template's blanks from the lead's own facts (name, service, business, call time); nothing is invented.
//   PREVIEW   before anything is saved, the screen lists EVERY person the campaign will go to with the exact words they will read, and every person left out with the reason.
//   SEND      a person with campaign rights approves (and may schedule); the sender re-asks the gate for each person at the moment of sending (a consent withdrawn since the preview, a STOP,
//             quiet hours, an unapproved template) and sends at most 20 a minute. Nothing is sent until switched on (Settings > WhatsApp AI > Marketing assistant > WhatsApp promotions).
//   RESULTS   from what really happened: sent, delivered and read (Meta's reports, where Meta sends them), replied and opted out within three days of the message, failed with the reason.
// The ticker never runs in the test sandbox; a test calls sweep().
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const { ensure } = require('./schema');

const clip = (v, n) => S.clip(v, n);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_PEOPLE = 500;
const BATCH = 20;
const ATTRIBUTION = 3 * DAY; // a reply or a STOP this soon after the message is counted for the campaign
const PROMO = /newsletter|campaign|promot|offer/i;
const FIELDS = ['name', 'service', 'business', 'callback'];
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const plain = (r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])) : null);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// ---- who may, and whether it is switched on --------------------------------------------------------------------------------------------------------------
function mayCampaign(user) {
  try { const A = require('../outreach/access'); return A.level(user) === 'admin' || !!A.has('mayCampaign')(user); } catch { return false; } // eslint-disable-line global-require
}
const gone = (msg, status = 400) => ({ error: msg, status });

// ---- the approved templates -----------------------------------------------------------------------------------------------------------------------------------
/** The WhatsApp templates a campaign can use: approved, with a Meta name. -> [{ id, name, metaName, language, body, blanks }] */
async function templates() {
  try {
    const rows = await S.q('SELECT id, name, body, waTemplateName, waLanguage, waApprovalStatus FROM "OutreachTemplate" WHERE channel = \'whatsapp\' AND status = \'active\' AND waApprovalStatus = \'approved\' AND waTemplateName IS NOT NULL AND waTemplateName <> \'\' ORDER BY updatedAt DESC LIMIT 100');
    return rows.map((r) => ({ id: r.id, name: r.name, metaName: r.waTemplateName, language: r.waLanguage || 'en', body: String(r.body || ''), blanks: new Set(String(r.body || '').match(/\{\{\d+\}\}/g) || []).size }));
  } catch { return []; }
}
async function templateById(id) { return (await templates()).find((t) => t.id === String(id)) || null; }

// ---- the people ---------------------------------------------------------------------------------------------------------------------------------------------------
// the latest consent per (lead, purpose); a lead has promotion consent when one promotion purpose is Given and none is Withdrawn
async function promoConsent() {
  const out = new Map();
  try {
    await require('../crm/plusSchema').ensure(); // eslint-disable-line global-require
    const rows = await require('../crm/schema').all('SELECT "recordId", "purpose", "status", "at" FROM "CrmConsent" WHERE "kind" = \'lead\' ORDER BY "at" ASC'); // eslint-disable-line global-require
    const latest = new Map();
    for (const r of rows) if (PROMO.test(r.purpose)) latest.set(`${r.recordId}|${r.purpose}`, r.status);
    for (const [k, status] of latest) { const id = k.split('|')[0]; const cur = out.get(id) || { given: false, withdrawn: false }; if (status === 'Given') cur.given = true; if (status === 'Withdrawn') cur.withdrawn = true; out.set(id, cur); }
  } catch { /* no consent table yet: nobody is consented */ }
  return out;
}
const phoneHint = (e164) => `+${String(e164).slice(0, 2)} •••••${String(e164).slice(-4)}`;

/**
 * The audience of a campaign now. filters: { bands: ['Hot', ...] | [], gapDays, max }.
 * -> { people: [{ leadId, name, e164, phoneHint, band, service, callback }], skipped: { reason: n }, samples: { reason: [names] }, considered }
 */
async function audience(filters = {}, { now = Date.now(), numberId = null } = {}) {
  await ensure();
  const Agent = require('./agent'); // eslint-disable-line global-require
  const DB = require('../crm/schema'); // eslint-disable-line global-require
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const bands = Array.isArray(filters.bands) ? filters.bands.filter((b) => ['Hot', 'Warm', 'Cold'].includes(b)) : [];
  const gap = Math.max(1, Math.min(90, Math.round(Number(filters.gapDays)) || 7));
  const max = Math.max(1, Math.min(MAX_PEOPLE, Math.round(Number(filters.max)) || MAX_PEOPLE));
  const skipped = {}; const samples = {};
  const skip = (why, name) => { skipped[why] = (skipped[why] || 0) + 1; (samples[why] = samples[why] || []).length < 3 && samples[why].push(clip(name, 40) || 'Unnamed'); };
  const consent = await promoConsent();
  const leads = await DB.all('SELECT * FROM "CrmLead" WHERE "status" <> \'Junk\' ORDER BY "createdAt" DESC LIMIT 3000').catch(() => []);
  // what the assistant learned about each lead (service, call time)
  const learned = new Map();
  for (const c of await S.q('SELECT collected FROM "OmniWaConv" WHERE collected LIKE \'%"crmLeadId"%\' LIMIT 3000')) { const l = parse(c.collected, {}).assistLead; if (l && l.crmLeadId) learned.set(l.crmLeadId, l); }
  const recent = new Set((await S.q('SELECT DISTINCT r.e164 AS e FROM "OmniWaMktRecipient" r WHERE r.status = \'sent\' AND r.sentAt >= ?', now - gap * DAY)).map((x) => x.e));
  const people = [];
  for (const l of leads) {
    const name = l.contactName || l.company || '';
    if (String(l.stage || '') === 'Lost') { skip('lost', name); continue; } // eslint-disable-line no-continue
    const c = consent.get(l.id);
    if (!c || !c.given || c.withdrawn) { skip('no recorded consent for promotions', name); continue; } // eslint-disable-line no-continue
    const m = core.normalizeMobile(l.phone);
    if (!m.ok) { skip('no usable WhatsApp number', name); continue; } // eslint-disable-line no-continue
    const e164 = String(m.e164).replace(/^\+/, '');
    const band = l.leadBand || l.rating || null;
    if (bands.length && !bands.includes(band)) { skip('outside the chosen Hot / Warm / Cold', name); continue; } // eslint-disable-line no-continue
    let blocked = true;
    try { blocked = (await Agent.blockState(e164)).blocked || (await require('./gate').crmOptedOut(e164)); } catch { blocked = true; } // eslint-disable-line global-require, no-await-in-loop -- fails closed
    if (blocked) { skip('asked us to stop (or the stop lists could not be read)', name); continue; } // eslint-disable-line no-continue
    if (recent.has(e164)) { skip(`already got a campaign message in the last ${gap} days`, name); continue; } // eslint-disable-line no-continue
    if (people.length >= max) { skip('over the limit for one campaign', name); continue; } // eslint-disable-line no-continue
    const k = learned.get(l.id) || {};
    people.push({ leadId: l.id, name: l.contactName || l.company || 'Customer', e164, phoneHint: phoneHint(e164), band, service: k.service || null, callback: k.callback || null });
  }
  return { people, skipped, samples, considered: leads.length };
}

// ---- the words ------------------------------------------------------------------------------------------------------------------------------------------------------
function valuesFor(p, businessName) {
  return { name: firstName(p.name) || 'there', service: p.service || 'our services', business: businessName || 'us', callback: p.callback || 'any time' };
}
const flat = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 100) || '-';
/** the blanks of the template for one person, and the words they will read. varMap: the field for {{1}}, {{2}} ... */
function render(body, varMap, person, businessName) {
  const val = valuesFor(person, businessName);
  const vars = varMap.map((k) => flat(val[k]));
  return { vars, text: String(body).replace(/\{\{(\d+)\}\}/g, (m, n) => vars[Number(n) - 1] || '-') };
}
function checkDraft(d, tpl) {
  if (!tpl) return 'Choose an approved WhatsApp template. Only an approved template can start a conversation with a customer.';
  const map = Array.isArray(d.varMap) ? d.varMap : [];
  if (map.some((k) => !FIELDS.includes(k))) return 'Each blank of the template is filled with the name, the service, the business or the call time.';
  if (map.length < tpl.blanks) return `This template has ${tpl.blanks} blank${tpl.blanks === 1 ? '' : 's'} ({{1}} ...): say what fills each one.`;
  return null;
}

/** Everything a campaign would do, nothing saved: -> { people: [{ ...person, text, vars }], skipped, samples, template } or { error } */
async function preview(user, draft = {}) {
  if (!mayCampaign(user)) return gone('Only a person with campaign rights can plan a campaign.', 403);
  const tpl = await templateById(draft.templateId);
  const bad = checkDraft(draft, tpl);
  if (bad) return gone(bad);
  const brand = (await require('./assist').settings()).businessName; // eslint-disable-line global-require
  const a = await audience(draft.audience || {});
  return { template: { id: tpl.id, name: tpl.name, metaName: tpl.metaName, body: tpl.body }, people: a.people.map((p) => ({ ...p, ...render(tpl.body, draft.varMap, p, brand) })), skipped: a.skipped, samples: a.samples, considered: a.considered };
}

// ---- the campaign -------------------------------------------------------------------------------------------------------------------------------------------------
const rowOf = async (id) => plain((await S.q('SELECT * FROM "OmniWaMktCampaign" WHERE id = ?', String(id)))[0]);
async function create(user, draft = {}) {
  await ensure();
  if (!mayCampaign(user)) return gone('Only a person with campaign rights can make a campaign.', 403);
  if (!(await require('./assist').settings()).campaignsOn) return gone('WhatsApp promotions are switched off. An Admin switches them on in Settings > WhatsApp AI > Marketing assistant.', 409); // eslint-disable-line global-require
  const name = clip(draft.name, 120);
  if (!name) return gone('Give the campaign a name.');
  const p = await preview(user, draft);
  if (p.error) return p;
  if (!p.people.length) return gone('Nobody would receive this campaign: nobody in the audience has agreed to promotions on WhatsApp yet. Nothing was saved.', 409);
  const id = S.newId('wmk'); const now = Date.now();
  const tpl = await templateById(draft.templateId);
  await S.run('INSERT INTO "OmniWaMktCampaign" (id, name, templateId, templateName, language, templateBody, varMap, audience, numberId, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, name, tpl.id, tpl.metaName, tpl.language, tpl.body, JSON.stringify(draft.varMap), JSON.stringify({ bands: (draft.audience || {}).bands || [], gapDays: (draft.audience || {}).gapDays || 7, max: (draft.audience || {}).max || MAX_PEOPLE }), draft.numberId ? String(draft.numberId) : null, 'ready', user.id || null, user.name || null, now, now);
  for (const x of p.people) await S.run('INSERT INTO "OmniWaMktRecipient" (id, campaignId, crmLeadId, e164, name, vars, body, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('wmr'), id, x.leadId, x.e164, clip(x.name, 120), JSON.stringify(x.vars), clip(x.text, 4000), 'queued', now, now); // eslint-disable-line no-await-in-loop
  return { ok: true, id, people: p.people.length, skipped: p.skipped };
}
/** Approve: send now, or at a time. at: epoch ms, at least a minute ahead and at most 30 days. */
async function approve(user, id, { at = null } = {}, now = Date.now()) {
  await ensure();
  if (!mayCampaign(user)) return gone('Only a person with campaign rights can send a campaign.', 403);
  const c = await rowOf(id);
  if (!c) return gone('This campaign is gone.', 404);
  if (c.status !== 'ready') return gone('This campaign was already started or stopped.', 409);
  if (!(await require('./assist').settings()).campaignsOn) return gone('WhatsApp promotions are switched off.', 409); // eslint-disable-line global-require
  let when = null;
  if (at) { when = Number(at); if (!Number.isFinite(when) || when < now + 60000 || when > now + 30 * DAY) return gone('Pick a time between one minute and thirty days from now.'); }
  await S.run('UPDATE "OmniWaMktCampaign" SET status = ?, scheduledAt = ?, approvedByName = ?, approvedAt = ?, startedAt = ?, updatedAt = ? WHERE id = ?', when ? 'scheduled' : 'sending', when, user.name || null, now, when ? null : now, now, c.id);
  return { ok: true, status: when ? 'scheduled' : 'sending', scheduledAt: when };
}
async function cancel(user, id, now = Date.now()) {
  await ensure();
  if (!mayCampaign(user)) return gone('Only a person with campaign rights can stop a campaign.', 403);
  const c = await rowOf(id);
  if (!c) return gone('This campaign is gone.', 404);
  if (!['ready', 'scheduled', 'sending'].includes(c.status)) return gone('This campaign is already finished or stopped.', 409);
  await S.run('UPDATE "OmniWaMktRecipient" SET status = \'skipped\', reason = \'The campaign was stopped.\', updatedAt = ? WHERE campaignId = ? AND status = \'queued\'', now, c.id);
  await S.run('UPDATE "OmniWaMktCampaign" SET status = \'cancelled\', finishedAt = ?, updatedAt = ? WHERE id = ?', now, now, c.id);
  return { ok: true };
}

// ---- sending --------------------------------------------------------------------------------------------------------------------------------------------------------
async function sendOne(c, r, now) {
  const Gate = require('./gate'); // eslint-disable-line global-require
  const pseudo = { e164: r.e164, numberId: c.numberId || null, collected: JSON.stringify({ assistLead: { crmLeadId: r.crmLeadId } }) };
  const tpl = { name: c.templateName, language: c.language || 'en', vars: parse(r.vars, []) };
  const g = await Gate.check(pseudo, { purpose: 'campaign', template: tpl, now });
  if (!g.ok) {
    if (['OPTED_OUT', 'NO_CONSENT'].includes(g.code)) { await S.run('UPDATE "OmniWaMktRecipient" SET status = \'skipped\', reason = ?, updatedAt = ? WHERE id = ?', clip(g.reason, 240), now, r.id); return 'skipped'; }
    return { wait: g };
  }
  const Sender = require('../marketing/sender'); // eslint-disable-line global-require
  let pk = await Sender.pick(null, c.numberId, { trusted: true });
  if (pk.error) pk = await Sender.pick(null, null);
  const res = await Sender.send({ to: `+${r.e164}`, kind: 'text', text: r.body, template: { name: tpl.name, language: tpl.language }, vars: tpl.vars, meta: { audience: 'leads', personName: clip(r.name, 80), purpose: 'WhatsApp promotion', module: 'WhatsApp assistant', automatic: true, template: tpl.name }, ...Sender.opts(pk) });
  if (!res || !res.ok) {
    const why = clip((res && res.error) || 'The sender refused it.', 200);
    await S.run('UPDATE "OmniWaMktRecipient" SET status = \'failed\', reason = ?, updatedAt = ? WHERE id = ?', why, now, r.id);
    return 'failed';
  }
  const t = Date.now();
  // the message is kept like every other WhatsApp message, so Meta's delivery reports (sent > delivered > read, failed) reach it by themselves; aiGenerated = 1 keeps it out of the recruitment promotion log
  await S.run('INSERT OR IGNORE INTO "OmniWaMessage" (id, e164, direction, body, template, status, providerMessageId, aiGenerated, campaignId, senderName, numberId, at, createdAt) VALUES (?,?,\'OUT\',?,?,?,?,1,?,?,?,?,?)',
    S.newId('wam'), r.e164, clip(r.body, 4000), tpl.name, 'sent', res.providerRef || null, `wmk:${c.id}`, 'Campaign', c.numberId || null, t, t);
  await S.run('UPDATE "OmniWaMktRecipient" SET status = \'sent\', providerMessageId = ?, sentAt = ?, updatedAt = ? WHERE id = ?', res.providerRef || null, t, t, r.id);
  return 'sent';
}

let busy = false;
// opts.force: also in the test sandbox. -> { sent, failed, skipped, waiting, done }
async function sweep(now = Date.now(), opts = {}) {
  const out = { sent: 0, failed: 0, skipped: 0, waiting: 0, done: 0 };
  if (!opts.force && require('../utils/sandbox').isSandbox()) return { ...out, sandbox: true }; // eslint-disable-line global-require
  if (busy) return { ...out, busy: true };
  busy = true;
  try {
    await ensure();
    if (!(await require('./assist').settings()).campaignsOn) return { ...out, off: true }; // eslint-disable-line global-require
    await S.run('UPDATE "OmniWaMktCampaign" SET status = \'sending\', startedAt = ?, updatedAt = ? WHERE status = \'scheduled\' AND scheduledAt <= ?', now, now, now);
    for (const c of (await S.q('SELECT * FROM "OmniWaMktCampaign" WHERE status = \'sending\' ORDER BY startedAt ASC LIMIT 5')).map(plain)) {
      let waiting = false; let note = null;
      for (const r of await S.q('SELECT * FROM "OmniWaMktRecipient" WHERE campaignId = ? AND status = \'queued\' ORDER BY createdAt ASC LIMIT ?', c.id, BATCH)) {
        const x = await sendOne(c, plain(r), now).catch((e) => { console.error('[omni-wa] campaign:', e && e.message); return 'failed'; }); // eslint-disable-line no-console, no-await-in-loop
        if (typeof x === 'object' && x.wait) { waiting = true; note = x.wait.reason; out.waiting += 1; break; }
        out[x] = (out[x] || 0) + 1;
      }
      const left = (await S.q('SELECT COUNT(*) AS n FROM "OmniWaMktRecipient" WHERE campaignId = ? AND status = \'queued\'', c.id))[0];
      if (!Number(left.n)) { await S.run('UPDATE "OmniWaMktCampaign" SET status = \'done\', finishedAt = ?, note = NULL, updatedAt = ? WHERE id = ?', now, now, c.id); out.done += 1; } else if (note) await S.run('UPDATE "OmniWaMktCampaign" SET note = ?, updatedAt = ? WHERE id = ?', clip(note, 240), now, c.id);
      if (waiting) continue; // eslint-disable-line no-continue
      await S.run('UPDATE "OmniWaMktCampaign" SET note = NULL WHERE id = ? AND status = \'sending\'', c.id);
    }
  } finally { busy = false; }
  return out;
}

// ---- results, from what really happened ---------------------------------------------------------------------------------------------------------------------------------
async function stats(id) {
  const rows = await S.q('SELECT r.status, r.reason, r.e164, r.sentAt, m.status AS msgStatus FROM "OmniWaMktRecipient" r LEFT JOIN "OmniWaMessage" m ON m.providerMessageId = r.providerMessageId AND m.providerMessageId IS NOT NULL WHERE r.campaignId = ?', String(id));
  const out = { total: rows.length, queued: 0, sent: 0, failed: 0, skipped: 0, delivered: 0, read: 0, replied: 0, optedOut: 0, failures: {} };
  for (const r of rows) {
    out[r.status] = (out[r.status] || 0) + 1;
    if (r.status === 'failed') out.failures[clip(r.reason, 80) || 'Unknown'] = (out.failures[clip(r.reason, 80) || 'Unknown'] || 0) + 1;
    if (r.status !== 'sent') continue; // eslint-disable-line no-continue
    if (['delivered', 'read'].includes(r.msgStatus)) out.delivered += 1;
    if (r.msgStatus === 'read') out.read += 1;
    const t = Number(r.sentAt);
    // eslint-disable-next-line no-await-in-loop
    if ((await S.q('SELECT 1 AS x FROM "OmniWaMessage" WHERE e164 = ? AND direction = \'IN\' AND at > ? AND at <= ? LIMIT 1', r.e164, t, t + ATTRIBUTION)).length) out.replied += 1;
    // eslint-disable-next-line no-await-in-loop
    if ((await S.q('SELECT 1 AS x FROM "OmniWaOptOut" WHERE e164 = ? AND at > ? AND at <= ? LIMIT 1', r.e164, t, t + ATTRIBUTION)).length) out.optedOut += 1;
  }
  const pct = (n) => (out.sent ? Math.round((n / out.sent) * 1000) / 10 : null);
  return { ...out, deliveredPct: pct(out.delivered), readPct: pct(out.read), repliedPct: pct(out.replied), optedOutPct: pct(out.optedOut), note: 'Delivered and read are what Meta reports (read only for people whose WhatsApp sends read receipts). Replied and opted out count the three days after the message.' };
}
async function list(user) {
  await ensure();
  if (!mayCampaign(user)) return { rows: [], canManage: false };
  const rows = (await S.q('SELECT * FROM "OmniWaMktCampaign" ORDER BY createdAt DESC LIMIT 100')).map(plain);
  const out = [];
  for (const c of rows) out.push({ id: c.id, name: c.name, templateName: c.templateName, status: c.status, scheduledAt: c.scheduledAt, createdByName: c.createdByName, approvedByName: c.approvedByName, createdAt: c.createdAt, finishedAt: c.finishedAt, note: c.note, stats: await stats(c.id) }); // eslint-disable-line no-await-in-loop
  return { rows: out, canManage: true, enabled: !!(await require('./assist').settings()).campaignsOn }; // eslint-disable-line global-require
}
/** one campaign with every recipient and the words each one got (or will get) */
async function get(user, id) {
  await ensure();
  if (!mayCampaign(user)) return gone('Only a person with campaign rights can open a campaign.', 403);
  const c = await rowOf(id);
  if (!c) return gone('This campaign is gone.', 404);
  const people = (await S.q('SELECT id, name, e164, body, status, reason, sentAt FROM "OmniWaMktRecipient" WHERE campaignId = ? ORDER BY createdAt ASC LIMIT 600', c.id)).map(plain).map((r) => ({ id: r.id, name: r.name, phoneHint: phoneHint(r.e164), text: r.body, status: r.status, reason: r.reason, sentAt: r.sentAt }));
  return { campaign: { id: c.id, name: c.name, templateName: c.templateName, templateBody: c.templateBody, status: c.status, scheduledAt: c.scheduledAt, note: c.note, createdByName: c.createdByName, approvedByName: c.approvedByName }, people, stats: await stats(c.id) };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(() => { sweep().catch((e) => console.error('[omni-wa] campaigns:', e && e.message)); }, 60000); // eslint-disable-line no-console
  if (timer.unref) timer.unref();
}

module.exports = { templates, audience, preview, create, approve, cancel, sweep, stats, list, get, render, mayCampaign, start, MAX_PEOPLE, FIELDS };
