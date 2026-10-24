// ---------------------------------------------------------------------------
// "NEW" ON EVERY DASHBOARD (user, 2026-10-13).
//
// One list of what reached THIS login and is not looked at yet:
//   job         a new job on my work (assigned to me / my team / my client)
//   candidate   a new person on one of my jobs
//   interview   a new interview on my work
//   agreement   an agreement step that waits for me (BDE team / Admin / the Tax & billing person)
//   message     anything else that came as a bell line (Notification rows), de-duplicated against the lines above
//
// Nothing new is stored per item: every row is read off data that already exists, inside the caller's own scope
// (utils/scope.js), so a Recruiter never sees a client fee and a TL never sees another team's people.
// WHICH ones were looked at is the only thing kept: one AppSetting row per login, key `newSeen.<userId>`,
// JSON { seen: { <itemKey>: <ISO time> } } (newest 600). An item stays New until the person opens it (Open button
// or "Mark all as seen"), then it moves to Seen.
//
//   GET  /api/new-items               { count, byKind, items:[{key,kind,title,text,at,link,seen}] }
//   POST /api/new-items/seen          { keys:[…] }  or  { all:true }
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const scope = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

const DAY = 86400000;
const KEEP = 600;
const seenKey = (uid) => `newSeen.${uid}`;
const clip = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function loadSeen(uid) {
  const row = await prisma.appSetting.findUnique({ where: { key: seenKey(uid) } }).catch(() => null);
  if (!row) return {};
  try { const v = JSON.parse(row.value); return (v && v.seen) || {}; } catch { return {}; }
}
async function saveSeen(user, seen) {
  const entries = Object.entries(seen).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, KEEP);
  const value = JSON.stringify({ seen: Object.fromEntries(entries) });
  await prisma.appSetting.upsert({
    where: { key: seenKey(user.id) },
    create: { key: seenKey(user.id), value, updatedById: user.id, updatedByName: user.name },
    update: { value, updatedById: user.id, updatedByName: user.name },
  });
}

const kindOfNote = (n) => {
  const t = `${n.title || ''} ${n.message || ''}`.toLowerCase();
  if (/agreement|e-?sign/.test(t)) return 'agreement';
  if (/interview/.test(t)) return 'interview';
  if (/candidate|applicant|resume|application/.test(t)) return 'candidate';
  if (/requirement|\bjob\b|req-\d/.test(t)) return 'job';
  return 'message';
};
const linkOfNote = (n, kind) => {
  const m = String(n.message || '').match(/Open:\s*(\/[^\s]+)/);
  if (m) return m[1];
  return { job: '/requirements', candidate: '/candidates', interview: '/interviews', agreement: '/clients' }[kind] || '/notifications';
};

async function derived(user) {
  const out = [];
  const s = scope.atsScopeOf(user);
  const hasAts = !!s.atsRole && !['CLIENT', 'CANDIDATE'].includes(s.atsRole) && !(user.role === 'CLIENT' || user.role === 'CANDIDATE');
  if (!hasAts) return out;
  const now = Date.now();

  // ---- new jobs -------------------------------------------------------------
  try {
    const jobs = await prisma.requirement.findMany({
      where: { AND: [scope.requirementWhere(user), { status: { not: 'CLOSED' } }, { createdAt: { gte: new Date(now - 14 * DAY) } }] },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, title: true, reqCode: true, createdAt: true, department: true, client: { select: { name: true } }, internal: true },
    });
    jobs.forEach((j) => out.push({
      key: `job:${j.id}`, kind: 'job', at: j.createdAt,
      title: `New requirement: ${j.title}`,
      text: [j.reqCode, j.internal ? 'TeamLink requirement' : (j.client && j.client.name), j.department].filter(Boolean).join(' · '),
      link: `/requirements/${j.id}`, ref: j.reqCode || null,
    }));
  } catch { /* the other kinds still show */ }

  // ---- new candidates -------------------------------------------------------
  try {
    const apps = await prisma.application.findMany({
      where: { AND: [scope.applicationWhere(user), { createdAt: { gte: new Date(now - 7 * DAY) } }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, createdAt: true, candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, reqCode: true } } },
    });
    apps.forEach((a) => out.push({
      key: `cand:${a.id}`, kind: 'candidate', at: a.createdAt,
      title: `New candidate: ${(a.candidate && a.candidate.name) || 'A candidate'}`,
      text: a.requirement ? `For ${a.requirement.title}${a.requirement.reqCode ? ` (${a.requirement.reqCode})` : ''}` : '',
      link: a.requirement ? `/requirements/${a.requirement.id}` : '/candidates',
    }));
  } catch { /* skip */ }

  // ---- new interviews -------------------------------------------------------
  try {
    const ints = await prisma.application.findMany({
      where: { AND: [scope.applicationWhere(user), { interviewAt: { gte: new Date(now - DAY) } }, { updatedAt: { gte: new Date(now - 7 * DAY) } }, { OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['Cancelled', 'Completed'] } }] }] },
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: { id: true, interviewAt: true, updatedAt: true, interviewCode: true, candidate: { select: { name: true } }, requirement: { select: { id: true, title: true } } },
    });
    ints.forEach((a) => out.push({
      key: `intv:${a.id}:${a.interviewAt ? a.interviewAt.toISOString().slice(0, 16) : ''}`, kind: 'interview', at: a.updatedAt,
      title: `New interview: ${(a.candidate && a.candidate.name) || 'A candidate'}`,
      text: `${a.requirement ? `${a.requirement.title} · ` : ''}${a.interviewAt ? a.interviewAt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`,
      link: '/interviews',
    }));
  } catch { /* skip */ }

  // ---- agreements waiting for me ----------------------------------------------
  try {
    const WF = require('../utils/agreementWorkflow'); // eslint-disable-line global-require
    const r = await WF.rolesOf(user);
    if (r.admin || r.bdeTl || r.bdeDesk || r.hr) {
      const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: WF.PREFIX } } });
      const parsed = rows.map((x) => { try { return { id: x.key.slice(WF.PREFIX.length), wf: JSON.parse(x.value) }; } catch { return null; } }).filter(Boolean)
        .filter((p) => ['WITH_HR', 'WITH_TL', 'DRAFT'].includes(p.wf.stage));
      if (parsed.length) {
        const scopeW = r.hr && !r.admin && !r.bdeTl && !r.bdeDesk ? {} : scope.clientWhere(user);
        const clients = await prisma.client.findMany({ where: { AND: [scopeW, { id: { in: parsed.map((p) => p.id) } }] }, select: { id: true, name: true, agreementStatus: true } });
        const wfOf = new Map(parsed.map((p) => [p.id, p.wf]));
        clients.forEach((c) => {
          const wf = wfOf.get(c.id);
          const stage = WF.stageOf(c, wf);
          const last = (wf.history || [])[(wf.history || []).length - 1] || null;
          const mine = (stage === 'WITH_HR' && r.hr) || (stage === 'WITH_TL' && (r.bdeTl || r.admin))
            || (stage === 'DRAFT' && last && String(last.action).startsWith('back_to') && (r.bdeDesk || r.bdeTl));
          if (!mine) return;
          out.push({
            key: `agr:${c.id}:${stage}:${last ? last.at : ''}`, kind: 'agreement', at: last ? last.at : new Date(),
            title: `Agreement waiting: ${c.name}`,
            text: stage === 'WITH_HR' ? 'Fill Tax & billing' : (stage === 'WITH_TL' ? 'Check everything and send to the client' : 'Fix what was asked and send it again'),
            link: stage === 'WITH_HR' ? `/tax-billing/${c.id}` : `/clients/${c.id}?tab=agreement`,
          });
        });
      }
    }
  } catch { /* skip */ }
  return out;
}

async function build(user) {
  const [seen, mine, notes] = await Promise.all([
    loadSeen(user.id),
    derived(user),
    prisma.notification.findMany({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, orderBy: { createdAt: 'desc' }, take: 60 }).catch(() => []),
  ]);
  const refs = mine.map((m) => m.ref).filter(Boolean);
  const items = [...mine];
  notes.forEach((n) => {
    const kind = kindOfNote(n);
    const hay = `${n.title || ''} ${n.message || ''}`;
    // A bell line about a job / person already listed above is the same news: show it once.
    if (['job', 'candidate'].includes(kind) && refs.some((r) => hay.includes(r))) return;
    items.push({
      key: `n:${n.id}`, kind, at: n.createdAt,
      title: clip(n.title, 110), text: clip(String(n.message || '').replace(/\s*Open:\s*\/\S+/, ''), 160), link: linkOfNote(n, kind), noteId: n.id,
    });
  });
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  const rows = items.map((i) => ({ ...i, seen: !!seen[i.key] }));
  return { rows, seen };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await build(req.user);
    const fresh = rows.filter((r) => !r.seen);
    const old = rows.filter((r) => r.seen).slice(0, 20);
    const byKind = {};
    fresh.forEach((r) => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
    return res.json({ count: fresh.length, byKind, items: [...fresh.slice(0, 60), ...old] });
  } catch (e) { return next(e); }
});

router.post('/seen', async (req, res, next) => {
  try {
    if (req.viewAs) return res.json({ ok: true, viewOnly: true });
    const b = req.body || {};
    const { rows, seen } = await build(req.user);
    const now = new Date().toISOString();
    const known = new Map(rows.map((r) => [r.key, r]));
    const keys = b.all ? rows.filter((r) => !r.seen).map((r) => r.key) : (Array.isArray(b.keys) ? b.keys.map(String).filter((k) => known.has(k)) : []);
    keys.forEach((k) => { seen[k] = now; });
    if (keys.length) {
      await saveSeen(req.user, seen);
      const noteIds = keys.map((k) => known.get(k)).filter((r) => r && r.noteId).map((r) => r.noteId);
      if (noteIds.length) await prisma.notification.updateMany({ where: { id: { in: noteIds }, userId: req.user.id }, data: { read: true } }).catch(() => {});
    }
    const left = rows.filter((r) => !r.seen && !keys.includes(r.key)).length;
    return res.json({ ok: true, marked: keys.length, count: left });
  } catch (e) { return next(e); }
});

module.exports = router;
