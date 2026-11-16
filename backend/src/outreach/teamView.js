// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CAMPAIGNS > MY TEAM (founder 2026-11-16): a Team Lead sees the recruiters of THEIR OWN department and, for those recruiters, the
// promotions / campaigns they ran, how many were sent, delivered, read and answered, and to whom. Admin sees every department (and may pick one).
// The server decides everything here (routes/omniGsCampaigns.js: GET /team, GET /team/campaign/:id/people); the page only draws it.
//   who may open it   admin (every department) · tl / stl / bdetl (their own department(s)). Anybody else: 403.
//   whose campaigns   campaigns CREATED by an active recruiter of the department(s) (not the TL's own, not another department's).
//   a campaign of another department's recruiter is never listed and its people are never returned (404).
// Phone and email are never in the answer; the name of a contact is hidden for logins that are masked (access.js masked()).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Camp = require('./campaigns');

const canon = (d) => {
  try { return String(require('../utils/bdeDesk').canonicalDepartment(d) || d || '').trim().toLowerCase(); } catch { return String(d || '').trim().toLowerCase(); } // eslint-disable-line global-require
};
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const ph = (n) => new Array(n).fill('?').join(',');

/** Which departments this login may look at: { all } for Admin, { departments } for a Team Lead, null = not allowed. */
function scopeFor(user) {
  const k = A.kind(user);
  if (k === 'admin') return { all: true, departments: [] };
  if (!['tl', 'bdetl'].includes(k)) return null;
  // the TL's OWN department(s) as TeamLink's WhatsApp numbers know them (department, team, ATS scope): no "family" widening like the ATS job scope has
  const departments = [...new Set([...require('../utils/waNumbers').departmentsOfUser(user)].map(canon).filter(Boolean))]; // eslint-disable-line global-require
  return departments.length ? { all: false, departments } : null;
}
const isRecruiterRow = (u) => [u.atsRole, u.role].some((r) => r === 'RECRUITER');

/** The active recruiters this login may see. */
async function recruitersFor(user, sc, dept) {
  const want = dept ? canon(dept) : '';
  const us = await prisma.user.findMany({ where: { status: 'Active' }, select: { id: true, name: true, atsRole: true, role: true, atsDepartment: true, department: true } });
  const deptOf = (u) => u.atsDepartment || u.department || '';
  return us.filter((u) => isRecruiterRow(u) && u.id !== user.id)
    .filter((u) => (sc.all ? (!want || canon(deptOf(u)) === want) : sc.departments.includes(canon(deptOf(u)))))
    .map((u) => ({ id: u.id, name: u.name, department: deptOf(u) }));
}

const dayMs = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? Date.parse(`${v}T${end ? '23:59:59.999' : '00:00:00'}+05:30`) : null);

/** The team view: per recruiter and per campaign. q = { from, to (YYYY-MM-DD), department (Admin only) } */
async function team(user, q = {}) {
  const sc = scopeFor(user);
  if (!sc) return { error: 'The team view is for Team Leads and Admins.', status: 403 };
  if (!(await S.campaignsReady())) return { ready: false, recruiters: [], campaigns: [], totals: {} };
  await Camp.ensureKind();
  const people = await recruitersFor(user, sc, sc.all ? q.department : '');
  const byId = new Map(people.map((p) => [p.id, p]));
  const from = dayMs(q.from, false); const to = dayMs(q.to, true);
  let rows = [];
  for (const part of chunk([...byId.keys()], 400)) {
    if (!part.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    rows = rows.concat(await S.q(`SELECT * FROM "OutreachCampaign" WHERE type <> 'internal' AND createdById IN (${ph(part.length)}) ORDER BY createdAt DESC, id DESC`, ...part));
  }
  rows = rows.filter((r) => (from == null || S.ms(r.createdAt) >= from) && (to == null || S.ms(r.createdAt) <= to));
  const counts = await Camp.countsFor(rows.map((r) => r.id));
  const mk = () => ({ campaigns: 0, recipients: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 });
  const per = new Map(people.map((p) => [p.id, { ...p, ...mk() }]));
  const campaigns = rows.map((r) => {
    const c = counts[r.id] || {}; const v = Camp.view(r); const p = byId.get(r.createdById);
    const o = {
      id: r.id, name: v.name, kindWords: v.kindWords, channel: v.channel, channelWords: v.channelWords, status: v.status, statusWords: v.statusWords, createdAt: v.createdAt,
      createdById: r.createdById, createdByName: (p && p.name) || v.createdByName || '', department: (p && p.department) || '',
      recipients: c.total || 0, sent: c.sent || 0, delivered: c.delivered || 0, read: c.read || 0, replied: c.replied || 0, failed: c.failed || 0,
    };
    const t = per.get(r.createdById);
    if (t) { t.campaigns += 1; t.recipients += o.recipients; ['sent', 'delivered', 'read', 'replied', 'failed'].forEach((f) => { t[f] += o[f]; }); }
    return o;
  });
  const recruiters = [...per.values()].sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
  const totals = recruiters.reduce((s, r) => { Object.keys(mk()).forEach((f) => { s[f] += r[f]; }); return s; }, mk());
  const departments = sc.all ? [...new Set((await prisma.user.findMany({ where: { status: 'Active' }, select: { atsDepartment: true, department: true } })).map((u) => u.atsDepartment || u.department).filter(Boolean))].sort() : [];
  const title = (d) => d.replace(/\b\w/g, (m) => m.toUpperCase());
  return {
    ready: true, all: sc.all, departments, recruiters, campaigns, totals,
    scopeWords: sc.all ? (q.department ? `Department: ${q.department}` : 'Every department') : `Your department: ${sc.departments.map(title).join(', ')}`,
  };
}

/** To whom one campaign went (a campaign of this login's team only). */
async function campaignPeople(user, id, { page = 1, pageSize = 50 } = {}) {
  const sc = scopeFor(user);
  if (!sc) return { error: 'The team view is for Team Leads and Admins.', status: 403 };
  const row = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', String(id)))[0];
  const people = row ? await recruitersFor(user, sc, '') : [];
  if (!row || row.type === 'internal' || !people.some((p) => p.id === row.createdById)) return { error: 'That campaign was not found.', status: 404 };
  const pg = Math.max(1, Math.floor(Number(page)) || 1); const ps = Math.min(200, Math.max(1, Math.floor(Number(pageSize)) || 50));
  const masked = A.masked(user);
  const total = num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ?', row.id))[0].n);
  const ms = await S.q('SELECT m.status, m.channel, m.sentAt, m.deliveredAt, m.readAt, m.repliedAt, c.name FROM "OutreachMessage" m LEFT JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId = ? ORDER BY COALESCE(m.sentAt, m.queuedAt) DESC LIMIT ? OFFSET ?', row.id, ps, (pg - 1) * ps);
  return {
    campaign: { id: row.id, name: row.name, createdByName: (people.find((p) => p.id === row.createdById) || {}).name || row.createdByName || '' },
    total, page: pg, pageSize: ps,
    people: ms.map((m) => ({
      name: masked ? 'Hidden' : (m.name || 'Unknown'), channel: m.channel, status: m.status, sentAt: S.iso(m.sentAt), deliveredAt: S.iso(m.deliveredAt), readAt: S.iso(m.readAt), repliedAt: S.iso(m.repliedAt), replied: !!m.repliedAt,
    })),
  };
}

module.exports = { team, campaignPeople, scopeFor };
