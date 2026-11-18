// ---------------------------------------------------------------------------
// Job Portal <-> Omni-Channel, one view of WhatsApp templates and campaigns (2026-11-18).
//   * the Job Portal's "Templates & Campaigns" asks TeamLink (bridge secret + the signed-in recruiter's e-mail) for the Omni-Channel
//     WhatsApp templates and campaigns THAT PERSON may see (the same Omni-Channel access and department rules), shaped like the portal's rows;
//   * the Omni-Channel template hub reads the portal's WhatsApp templates (portalTemplates) and shows them as "Job Portal" items.
// Read-only on the other side: a template or campaign is edited where it was made. Nothing is copied into a second store.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { resolveIdentity } = require('./identity');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function identityFor(emailRaw) {
  const email = clip(emailRaw, 200).trim();
  if (!email) return null;
  const users = await prisma.user.findMany({ where: { email: { in: [email.toLowerCase(), email] }, status: 'Active' }, select: { id: true } });
  for (const u of users) { // eslint-disable-line no-restricted-syntax
    const idn = await resolveIdentity(u.id); // eslint-disable-line no-await-in-loop
    if (idn) return idn;
  }
  return null;
}

const WA_APPROVAL = { Approved: 'approved', Pending: 'waiting', Rejected: 'changes_needed' };
function templateRow(i) {
  const status = i.wa && i.wa.status;
  return {
    id: `omni:${i.key}`, name: i.name, channel: 'whatsapp', subject: i.subject || '', body: i.body || '',
    department: i.department || '', usedIn: ['Omni-Channel', ...(i.where || []).filter((w) => w !== 'Omni-Channel')].slice(0, 4),
    approval: WA_APPROVAL[status] || 'waiting', approvalNote: null, version: 1, source: 'omni', archived: false,
    createdBy: i.byName || null, updatedAt: i.updatedAt, approvedAt: null,
    wa: i.wa && i.wa.name ? { waName: i.wa.name, language: i.language || '', status: status || 'None' } : null,
    canEdit: false, canArchive: false, canReview: false, canDuplicate: false, fromOmni: true,
  };
}

async function omniTemplates(email) {
  const u = await identityFor(email);
  if (!u) return { ok: false, status: 403, error: 'This portal login is not linked to a TeamLink login.' };
  const Hub = require('../outreach/hub'); // eslint-disable-line global-require
  const out = await Hub.list(u, { where: 'all', channel: 'WhatsApp' });
  const items = (out.items || []).filter((i) => ['message', 'outreach'].includes(i.source)).map(templateRow);
  return { ok: true, templates: items, departments: [...new Set(items.map((x) => x.department).filter(Boolean))] };
}

const STATUS = (s) => (/done|complete|finish/i.test(s) ? 'completed' : (/run|prepar|send/i.test(s) ? 'running' : (/pause|hold/i.test(s) ? 'paused' : (/stop|cancel/i.test(s) ? 'cancelled' : 'draft'))));
async function omniCampaigns(email) {
  const u = await identityFor(email);
  if (!u) return { ok: false, status: 403, error: 'This portal login is not linked to a TeamLink login.' };
  const Camp = require('../outreach/campaigns'); // eslint-disable-line global-require
  const out = await Camp.list(u, { pageSize: 100 });
  const rows = (out.campaigns || out.rows || out.items || []).filter((c) => String(c.channel || '').toLowerCase() === 'whatsapp').map((c) => ({
    id: `omni:${c.id}`, name: c.name, channel: 'whatsapp', usedIn: c.templateName ? [c.templateName] : [], department: 'All departments',
    status: STATUS(String(c.status || '')), owner: c.createdByName || null, createdAt: c.createdAt,
    messages: (c.counts || {}).total || 0, sent: (c.counts || {}).sent || 0, delivered: (c.counts || {}).delivered || 0, read: (c.counts || {}).read || 0,
    failed: (c.counts || {}).failed || 0, pending: (c.counts || {}).waiting || 0, fromOmni: true,
  }));
  return { ok: true, campaigns: rows };
}

// the portal's own WhatsApp templates, for the Omni-Channel hub (cached for a short while; a portal that is down simply adds nothing)
let cache = { at: 0, rows: [] };
async function portalTemplates() {
  if (Date.now() - cache.at < 30000) return cache.rows;
  try {
    const bridge = require('./jobPortalBridge'); // eslint-disable-line global-require
    const r = await bridge.portalFetch('/integrations/teamlink/comm-templates', { timeoutMs: 6000 });
    cache = { at: Date.now(), rows: Array.isArray(r && r.templates) ? r.templates : [] };
  } catch { cache = { at: Date.now() - 20000, rows: cache.rows }; }
  return cache.rows;
}

// ---- the approved WhatsApp templates of Omni-Channel / Message templates, given to the portal's "Send WhatsApp Message" ------------------
// The portal sends a template only when it holds an APPROVED WhatsApp template row (comm_templates). So the approved ones are pushed there
// (embed PUT /api/integrations/teamlink/comm-templates -> comm_template_wa_upsert), at start and every 10 minutes. Variables are renamed to the
// portal's field names; a template that uses a variable the portal cannot fill (unsubscribe) is left out and named in the answer.
const KEY_OF = { name: 'candidate_name', job_title: 'job_title', company: 'company_name', apply_link: 'job_link', candidate_name: 'candidate_name', first_name: 'first_name', job_location: 'job_location', location: 'location', notice_period: 'notice_period', recruiter_name: 'recruiter_name', company_name: 'company_name', job_link: 'job_link' };
const slugLang = (l) => { const v = String(l || '').trim(); const m = { english: 'en', telugu: 'te', hindi: 'hi' }; return m[v.toLowerCase()] || v || 'en_US'; };
function portalShape({ id, name, body, waName, language, department }) {
  const used = [...String(body || '').matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
  if (used.some((k) => !KEY_OF[k])) return { skip: `${name}: uses a detail the portal cannot fill (${used.find((k) => !KEY_OF[k])})` };
  const text = String(body || '').replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (m, k) => `{{${KEY_OF[k.toLowerCase()]}}}`);
  return { row: { id: clip(id, 60), name: clip(name, 120), body: clip(text, 8000), waName: clip(waName, 200), language: slugLang(language), params: used.map((k) => KEY_OF[k]), department: department || '', usedIn: ['Omni-Channel'] } };
}
async function approvedWhatsApp() {
  const rows = []; const skipped = [];
  try {
    const S = require('../outreach/store'); // eslint-disable-line global-require
    if (await S.ready()) {
      const ot = await S.q("SELECT id, name, body, waTemplateName, waLanguage FROM \"OutreachTemplate\" WHERE channel = 'whatsapp' AND status = 'active' AND LOWER(COALESCE(waApprovalStatus,'')) = 'approved' AND COALESCE(waTemplateName,'') <> ''");
      ot.forEach((r) => { const o = portalShape({ id: `omni_${r.id}`, name: r.name, body: r.body, waName: r.waTemplateName, language: r.waLanguage }); if (o.row) rows.push(o.row); else skipped.push(o.skip); });
    }
  } catch { /* outreach tables not there yet */ }
  try {
    const mt = await prisma.messageTemplate.findMany({ where: { channel: 'WhatsApp', active: true, waStatus: 'Approved', audience: 'candidate', NOT: { waTemplateName: null } } });
    mt.forEach((r) => { const o = portalShape({ id: `msg_${r.id}`, name: r.name, body: r.body, waName: r.waTemplateName, language: r.waLanguageCode || r.language }); if (o.row) rows.push(o.row); else skipped.push(o.skip); });
  } catch { /* none */ }
  return { rows, skipped };
}
async function pushTemplatesToPortal() {
  const { rows, skipped } = await approvedWhatsApp();
  if (!rows.length) return { ok: true, pushed: 0, skipped };
  const bridge = require('./jobPortalBridge'); // eslint-disable-line global-require
  const out = await bridge.portalFetch('/integrations/teamlink/comm-templates', { method: 'PUT', body: { templates: rows }, timeoutMs: 20000 });
  return { ok: true, pushed: rows.length, result: out, skipped };
}
let timer = null;
function startSync() {
  if (timer) return;
  const run = () => pushTemplatesToPortal().catch(() => {});
  setTimeout(run, 60000).unref();
  timer = setInterval(run, 10 * 60 * 1000);
  timer.unref();
}

module.exports = { omniTemplates, omniCampaigns, portalTemplates, identityFor, pushTemplatesToPortal, approvedWhatsApp, portalShape, startSync };
