// ---------------------------------------------------------------------------
// WHATSAPP TEMPLATES FROM META, IN BOTH APPS (founder 2026-10-31: "what template ekkadena create chesukovali ekkade approvals ravali").
//
// A WhatsApp template belongs to the WhatsApp Business Account (WABA) at Meta, not to TeamLink or Omni-Channel. A template made in Manage
// Templates (TeamLink) and one made in Omni-Channel's Templates page land in the SAME list at Meta. So both apps read that one list:
//   TeamLink      every template with the same name takes Meta's answer for that account (as "Check with Meta" does); a template only Meta
//                 has (made in Omni-Channel or in Meta Business Manager) is ADDED to Manage Templates with Meta's status, marked "from Meta"
//   Omni-Channel  every workspace that has a TeamLink WhatsApp number runs Green Start's own "Sync with Meta" (POST /templates/sync): it takes
//                 Meta's status and imports the templates TeamLink made (utils/greenStartIntegrations.js templatesToOmni)
// When: every 15 minutes, and on "Bring approvals from Meta now" (Admin). Nothing is ever marked Approved by us: only Meta's answer is copied.
// Never in test mode. No token leaves the server; nothing is deleted on either side.
// ---------------------------------------------------------------------------
const S = require('./store');
const T = require('./templates');
const P = require('./tplPolicy');
const Waba = require('./tplWaba');
const { logAudit } = require('../utils/audit');

const META_STATUS = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', PENDING_DELETION: 'pending', REJECTED: 'rejected', PAUSED: 'approved', DISABLED: 'rejected' };
const SYSTEM = { id: null, name: 'Meta (automatic check)' };
const nowIso = () => new Date().toISOString();
const wa = () => require('../utils/whatsappCloud'); // eslint-disable-line global-require

// every template of one account at Meta (paged; at most 1,000)
async function listAt(cfg) {
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  let url = `${cfg.base}/${wa().VERSION}/${encodeURIComponent(cfg.wabaId)}/message_templates?fields=id,name,status,category,language,rejected_reason,components&limit=100`;
  const out = [];
  for (let page = 0; url && page < 10; page += 1) {
    const res = await core.httpJson(url, { headers: { authorization: `Bearer ${cfg.token}` } }); // eslint-disable-line no-await-in-loop
    if (!res.ok) return { error: `Meta could not be asked: ${S.clip((res.json && res.json.error && res.json.error.message) || res.networkError || res.text || res.status, 200)}` };
    out.push(...((res.json && res.json.data) || []));
    url = res.json && res.json.paging && res.json.paging.next ? res.json.paging.next : null;
  }
  return { list: out };
}

// Meta's template -> the words and layout Manage Templates shows (variables stay as Meta has them, e.g. {{1}})
function layoutOf(hit) {
  const comp = (type) => (hit.components || []).find((c) => String(c.type).toUpperCase() === type) || null;
  const h = comp('HEADER'); const b = comp('BODY'); const f = comp('FOOTER'); const bt = comp('BUTTONS');
  const extra = {};
  if (h) extra.headerType = ({ TEXT: 'text', IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document', LOCATION: 'location' })[String(h.format).toUpperCase()] || 'none';
  if (h && h.text) extra.headerText = h.text;
  if (f && f.text) extra.footer = f.text;
  if (bt && Array.isArray(bt.buttons)) {
    extra.buttons = bt.buttons.map((x) => ({
      type: ({ QUICK_REPLY: 'reply', URL: 'url', PHONE_NUMBER: 'phone', COPY_CODE: 'code', FLOW: 'flow' })[String(x.type).toUpperCase()] || 'reply',
      label: x.text || '', url: x.url || '', phone: x.phone_number || '', code: x.example ? String(x.example) : '',
    }));
  }
  const cat = String(hit.category || '').toUpperCase();
  return { body: String((b && b.text) || '').slice(0, 4000) || '(no text)', extra, category: cat === 'MARKETING' ? 'Marketing' : (cat === 'AUTHENTICATION' ? 'Authentication' : 'Utility'), promotional: cat === 'MARKETING' };
}

// TeamLink side: every active WhatsApp template takes Meta's answer; templates only Meta has are added
async function refreshTeamLink() {
  if (require('../utils/sandbox').isSandbox()) return { skipped: 'test mode' }; // eslint-disable-line global-require
  if (!(await S.ready())) return { skipped: 'Omni-Channel tables are not set up yet' };
  await Waba.ensure();
  const acc = await Waba.accounts();
  const targets = acc.accounts.filter((g) => g.cfg && !wa().simulated(g.cfg));
  const rows = await S.q('SELECT * FROM "OutreachTemplate" WHERE channel = \'whatsapp\' AND status = \'active\'');
  const byName = new Map();
  rows.forEach((r) => { const k = P.slug(r.waTemplateName || r.name); if (!byName.has(k)) byName.set(k, r); });
  const report = { accounts: 0, updated: 0, added: [], failed: [] };
  const touched = new Set();
  for (const g of targets) { // eslint-disable-line no-restricted-syntax
    const got = await listAt(g.cfg); // eslint-disable-line no-await-in-loop
    if (got.error) { report.failed.push(`${g.numbers.map((n) => n.label).join(', ')}: ${got.error}`); continue; } // eslint-disable-line no-continue
    report.accounts += 1;
    for (const hit of got.list) { // eslint-disable-line no-restricted-syntax
      if (!hit || !hit.name || String(hit.status).toUpperCase() === 'DELETED') continue; // eslint-disable-line no-continue
      const f = { status: META_STATUS[String(hit.status || '').toUpperCase()] || 'pending', metaId: hit.id ? String(hit.id) : null, metaStatus: String(hit.status || ''), reason: hit.rejected_reason && hit.rejected_reason !== 'NONE' ? String(hit.rejected_reason) : '', checkedAt: nowIso() };
      let row = byName.get(hit.name);
      if (!row) {
        // made in Omni-Channel (or in Meta Business Manager): add it, so its approval shows here too
        const l = layoutOf(hit);
        const id = S.newId('ot'); const now = Date.now();
        await S.run(`INSERT INTO "OutreachTemplate" (id, name, channel, audience, promotional, subject, body, waTemplateName, waLanguage, waApprovalStatus, dltTemplateId, senderId, status, createdById, createdByName, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`, id, S.clip(hit.name, 80), 'whatsapp', 'candidate_lead', l.promotional ? 1 : 0, null, l.body, S.clip(hit.name, 120), S.clip(hit.language || 'en_US', 12), f.status, null, null, null, 'From Meta (made in Omni-Channel or Business Manager)', now, now); // eslint-disable-line no-await-in-loop
        await T.saveExtras(id, { category: l.category, promotional: l.promotional, extra: { ...l.extra, meta: { id: f.metaId, status: f.metaStatus, reason: f.reason, checkedAt: f.checkedAt, wabaId: g.wabaId, from: 'meta' }, review: { source: 'meta' } } }); // eslint-disable-line no-await-in-loop
        row = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0]; // eslint-disable-line no-await-in-loop
        byName.set(hit.name, row);
        report.added.push(hit.name);
      }
      await Waba.put(row.id, g.wabaId, f); // eslint-disable-line no-await-in-loop
      touched.add(row.id);
    }
  }
  // the summary column follows the per-account answers (the same rule as "Check with Meta")
  for (const id of touched) await Waba.aggregate(id); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  report.updated = touched.size - report.added.length;
  if (report.added.length) {
    await logAudit({ userId: null, actorName: SYSTEM.name, action: 'WhatsApp templates added from Meta', entity: 'OutreachTemplate', entityId: 'meta', toValue: S.clip(report.added.join(', '), 480) });
  }
  return report;
}

// both apps at once
let running = null;
let last = null;
async function bothWays() {
  if (running) return running;
  running = (async () => {
    const out = { at: nowIso() };
    try { out.teamlink = await refreshTeamLink(); } catch (err) { out.teamlink = { error: err.message }; }
    try { out.omni = await require('../utils/greenStartIntegrations').templatesToOmni(); } catch (err) { out.omni = { error: err.message }; } // eslint-disable-line global-require
    const t = out.teamlink || {}; const o = out.omni || {};
    const parts = [];
    if (t.error || t.skipped) parts.push(`TeamLink: ${t.error || t.skipped}`);
    else parts.push(`TeamLink: ${t.accounts} WhatsApp account${t.accounts === 1 ? '' : 's'} checked, ${t.updated} template${t.updated === 1 ? '' : 's'} updated${t.added.length ? `, ${t.added.length} added from Omni-Channel / Meta` : ''}${t.failed.length ? `; not reached: ${t.failed.join(' | ')}` : ''}`);
    if (o.error) parts.push(`Omni-Channel: ${o.error}`);
    else parts.push(`Omni-Channel: ${o.words}`);
    out.words = parts.join('. ');
    last = out;
    return out;
  })();
  try { return await running; } finally { running = null; }
}

function start() {
  if (process.env.NODE_ENV === 'test' || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  const first = setTimeout(() => bothWays().catch(() => {}), 3 * 60 * 1000);
  const every = setInterval(() => bothWays().catch(() => {}), 15 * 60 * 1000);
  if (first.unref) first.unref();
  if (every.unref) every.unref();
}

module.exports = { refreshTeamLink, bothWays, start, layoutOf, lastRun: () => last };
