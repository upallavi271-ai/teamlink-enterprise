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

module.exports = { omniTemplates, omniCampaigns, portalTemplates, identityFor };
