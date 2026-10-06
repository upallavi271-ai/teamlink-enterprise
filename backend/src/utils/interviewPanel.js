// ---------------------------------------------------------------------------
// INTERVIEW PANEL (B4, 2026-10-06) — several interviewers per interview round.
//
//   * a panelist is a staff login (userId) or an outside person (name + email);
//   * each panelist has their OWN scorecard (technical / communication /
//     experience / role fit 1-5, a note, Selected / Rejected / Hold);
//   * the interview's overall decision stays ONE: the Internal
//     InterviewFeedback row + POST /ats/interviews/:id/decision, exactly as
//     before. Panel scorecards never overwrite it and are never averaged into
//     the AI score.
//   * Application.interviewer (the old single text field) is still written —
//     the panel's names, comma-separated — so every older screen, notice and
//     WhatsApp text keeps working.
//   * OLD ROWS: an interview with no panel rows but an `interviewer` text is
//     read as a one-person panel ("migrate on read"); its feedback is the
//     Internal feedback already on file. Nothing is rewritten in the database.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ready = () => !!(prisma.interviewPanelist && typeof prisma.interviewPanelist.findMany === 'function');
const MAX_PANEL = 8;
const RECS = ['Selected', 'Rejected', 'Hold'];
const isTestName = (s) => /zztest|example\.test/i.test(String(s || ''));
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));

// Validates what the booking / panel form sent. Returns { entries } or { error }.
// entries: [{ userId, name, email }]
async function parsePanel(raw) {
  if (raw === undefined || raw === null) return { entries: null };
  if (!Array.isArray(raw)) return { error: 'The panel should be a list of people.' };
  if (raw.length > MAX_PANEL) return { error: `A panel can have at most ${MAX_PANEL} people.` };
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (!p || typeof p !== 'object') return { error: 'Each panel member needs a name.' };
    if (p.userId) {
      // eslint-disable-next-line no-await-in-loop
      const u = await prisma.user.findUnique({ where: { id: String(p.userId) }, select: { id: true, name: true, email: true, role: true, status: true } });
      if (!u || u.status !== 'Active' || ['CANDIDATE', 'CLIENT'].includes(u.role)) return { error: 'One of the chosen staff members is not an active TeamLink login.' };
      if (seen.has(`u:${u.id}`)) continue;
      seen.add(`u:${u.id}`);
      out.push({ userId: u.id, name: u.name, email: u.email || null });
    } else {
      const name = String(p.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const email = String(p.email || '').trim().toLowerCase().slice(0, 160);
      if (name.length < 2) return { error: 'Write the name of each outside interviewer.' };
      if (email && !validEmail(email)) return { error: `"${email}" is not a valid email.` };
      const key = `x:${email || name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ userId: null, name, email: email || null });
    }
  }
  return { entries: out };
}

const namesOf = (entries) => entries.map((e) => e.name).join(', ').slice(0, 120);

// Sets the panel of one round. People who already gave feedback stay (their
// scorecard is never thrown away); everyone else is replaced by the new list.
async function setPanel(applicationId, round, entries) {
  if (!ready() || !entries) return [];
  const rows = await prisma.interviewPanelist.findMany({ where: { applicationId, round } });
  const same = (r, e) => (e.userId ? r.userId === e.userId : (!r.userId && ((e.email && r.email === e.email) || (!e.email && r.name.toLowerCase() === e.name.toLowerCase()))));
  const keep = rows.filter((r) => entries.some((e) => same(r, e)) || r.feedbackAt);
  const drop = rows.filter((r) => !keep.includes(r));
  if (drop.length) await prisma.interviewPanelist.deleteMany({ where: { id: { in: drop.map((r) => r.id) } } });
  let pos = 0;
  for (const e of entries) {
    const hit = keep.find((r) => same(r, e));
    // eslint-disable-next-line no-await-in-loop
    if (hit) await prisma.interviewPanelist.update({ where: { id: hit.id }, data: { position: pos, name: e.name, email: e.email } });
    // eslint-disable-next-line no-await-in-loop
    else await prisma.interviewPanelist.create({ data: { applicationId, round, userId: e.userId, name: e.name, email: e.email, position: pos } });
    pos += 1;
  }
  return prisma.interviewPanelist.findMany({ where: { applicationId, round }, orderBy: { position: 'asc' } });
}

function shapeMember(r) {
  return {
    id: r.id,
    userId: r.userId || null,
    name: r.name,
    email: r.email || null,
    external: !r.userId,
    round: r.round,
    feedback: r.feedbackAt ? {
      technical: r.technical, communication: r.communication, experience: r.experience, roleFit: r.roleFit,
      overall: r.overall, recommendation: r.recommendation, at: r.feedbackAt, by: r.feedbackByName,
    } : null,
  };
}

// The panel of each application's CURRENT round, migrated on read for old rows.
// apps: [{ id, interviewRound, interviewer, interviewFeedbacks? }]
async function panelsFor(apps) {
  const map = new Map();
  if (!apps.length) return map;
  let rows = [];
  if (ready()) {
    for (let i = 0; i < apps.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      rows = rows.concat(await prisma.interviewPanelist.findMany({ where: { applicationId: { in: apps.slice(i, i + 500).map((a) => a.id) } }, orderBy: [{ round: 'asc' }, { position: 'asc' }] }));
    }
  }
  apps.forEach((a) => {
    const round = a.interviewRound || 1;
    const mine = rows.filter((r) => r.applicationId === a.id && r.round === round);
    if (mine.length) { map.set(a.id, mine.map(shapeMember)); return; }
    // Migrate on read: the old single interviewer, with the Internal feedback on file.
    const who = String(a.interviewer || '').trim();
    if (!who) { map.set(a.id, []); return; }
    const fb = (a.interviewFeedbacks || []).find((f) => f.kind === 'Internal');
    map.set(a.id, [{
      id: null, userId: null, name: who, email: null, external: false, legacy: true, round,
      feedback: fb ? { technical: fb.technical, communication: fb.communication, experience: fb.experience, roleFit: fb.roleFit, overall: fb.overall, recommendation: fb.recommendation, at: fb.updatedAt, by: fb.submittedBy } : null,
    }]);
  });
  return map;
}

// Staff logins on the current round's panel (for notices and reminders).
async function panelStaff(applicationId, round) {
  if (!ready()) return [];
  const rows = await prisma.interviewPanelist.findMany({ where: { applicationId, round: round || 1, userId: { not: null } }, select: { userId: true } });
  if (!rows.length) return [];
  return prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) }, status: 'Active' }, select: { id: true, name: true, email: true } });
}
async function panelExternal(applicationId, round) {
  if (!ready()) return [];
  return prisma.interviewPanelist.findMany({ where: { applicationId, round: round || 1, userId: null, email: { not: null } }, select: { name: true, email: true } });
}

// One panelist's own scorecard.
function readScorecard(body) {
  const b = body || {};
  const rating = (v) => {
    if (v === '' || v == null) return null;
    const n = Math.round(Number(v));
    return Number.isNaN(n) ? null : Math.max(1, Math.min(5, n));
  };
  const rec = RECS.find((r) => r.toLowerCase() === String(b.recommendation || '').trim().toLowerCase());
  const overall = String(b.overall || b.feedback || '').trim().slice(0, 4000);
  if (!rec) return { error: 'Pick Selected, Rejected or Hold.' };
  if (overall.length < 2) return { error: 'Write a short note on how it went.' };
  return {
    data: {
      technical: rating(b.technical), communication: rating(b.communication), experience: rating(b.experience), roleFit: rating(b.roleFit),
      overall, recommendation: rec,
    },
  };
}

// Staff a panel can be picked from: active logins that are not candidates or
// clients, by name / email. Test logins are hidden on the real server.
async function staffOptions(q) {
  // eslint-disable-next-line global-require
  const sandbox = require('./sandbox').isSandbox();
  const term = String(q || '').trim();
  const rows = await prisma.user.findMany({
    where: {
      status: 'Active',
      role: { notIn: ['CANDIDATE', 'CLIENT'] },
      ...(term ? { OR: [{ name: { contains: term } }, { email: { contains: term } }] } : {}),
    },
    select: { id: true, name: true, email: true, role: true, atsRole: true },
    orderBy: { name: 'asc' },
    take: 40,
  });
  return rows.filter((u) => sandbox || !isTestName(`${u.name} ${u.email}`)).slice(0, 20)
    .map((u) => ({ id: u.id, name: u.name, role: u.atsRole || u.role }));
}

module.exports = {
  ready, MAX_PANEL, parsePanel, namesOf, setPanel, panelsFor, panelStaff, panelExternal, readScorecard, staffOptions, shapeMember,
};
