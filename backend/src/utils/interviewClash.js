// ---------------------------------------------------------------------------
// INTERVIEW CLASHES AND THE PANEL'S DAY (founder ATS audit 2026-11-17, Mandatory: "schedule interviews by team availability").
// Before an interview is booked the booking window asks here: does any interviewer on the panel, or the candidate, already have
// an interview within an hour of that time? And what has each interviewer booked that day, so a free time can be picked.
// A warning, not a block: the person booking sees the clash and may still book (a panel can take two back to back).
//
//   check({ user, applicationId, date, time, panel, interviewer })
//     date YYYY-MM-DD, time HH:MM (India time); panel [{ userId } | { name }]; interviewer = the old free-text names
//     -> { at, windowMinutes, clashes: [...], booked: [...], freeTimes: [...] }
// Another person's interview that this login may not see is shown as "Another interview" (no name, no job).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { applicationWhere } = require('./scope');

const WINDOW_MIN = 60; // an interview is taken to last an hour
const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const splitNames = (s) => String(s || '').split(/[,;&/]| and /i).map(norm).filter((x) => x.length >= 2);
const istTime = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(11, 16);

async function whoOf(panel, interviewer) {
  const ids = new Set();
  const names = new Map(); // normalised name -> shown name
  for (const p of Array.isArray(panel) ? panel.slice(0, 12) : []) {
    if (p && p.userId) ids.add(String(p.userId));
    else if (p && p.name && norm(p.name).length >= 2) names.set(norm(p.name), String(p.name).trim().slice(0, 120));
  }
  if (ids.size) {
    const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
    users.forEach((u) => names.set(norm(u.name), u.name));
  }
  splitNames(interviewer).forEach((n) => { if (!names.has(n)) names.set(n, n.replace(/\b\w/g, (c) => c.toUpperCase())); });
  return { ids, names };
}

async function check({ user, applicationId, date, time, panel, interviewer }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { error: 'Pick the interview date.' };
  const t = /^\d{2}:\d{2}$/.test(String(time || '')) ? String(time) : null;
  const app = await prisma.application.findFirst({
    where: { id: String(applicationId || ''), ...applicationWhere(user) },
    select: { id: true, candidateId: true, candidate: { select: { name: true } } },
  });
  if (!app) return { error: 'That application is not in your list.', status: 404 };
  const dayStart = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(dayStart.getTime())) return { error: 'That date is not valid.' };
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const at = t ? new Date(`${date}T${t}:00+05:30`) : null;
  const who = await whoOf(panel, interviewer);

  // Every live interview that day (and an hour either side, for a slot near midnight), except this application's own.
  const rows = await prisma.application.findMany({
    where: {
      id: { not: app.id }, interviewStatus: { in: LIVE },
      interviewAt: { gte: new Date(dayStart.getTime() - WINDOW_MIN * 60000), lt: new Date(dayEnd.getTime() + WINDOW_MIN * 60000) },
    },
    select: { id: true, candidateId: true, interviewAt: true, interviewer: true, interviewRound: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } },
    take: 2000,
  });
  const panelRows = rows.length ? await prisma.interviewPanelist.findMany({
    where: { applicationId: { in: rows.map((r) => r.id) } }, select: { applicationId: true, round: true, userId: true, name: true },
  }).catch(() => []) : [];
  const visible = rows.length ? new Set((await prisma.application.findMany({
    where: { AND: [{ id: { in: rows.map((r) => r.id) } }, applicationWhere(user)] }, select: { id: true },
  })).map((r) => r.id)) : new Set();

  const booked = [];
  const clashes = [];
  const near = (d) => at && Math.abs(new Date(d).getTime() - at.getTime()) < WINDOW_MIN * 60000;
  const label = (r) => (visible.has(r.id) ? { candidate: r.candidate ? r.candidate.name : null, job: r.requirement ? r.requirement.title : null, applicationId: r.id } : { candidate: 'Another interview', job: null, applicationId: null });
  rows.forEach((r) => {
    const round = r.interviewRound || 1;
    const pan = panelRows.filter((p) => p.applicationId === r.id && (p.round || 1) === round);
    const theirNames = new Set([...splitNames(r.interviewer), ...pan.map((p) => norm(p.name))]);
    const theirIds = new Set(pan.map((p) => p.userId).filter(Boolean));
    const shared = [...who.names.entries()].filter(([n]) => theirNames.has(n)).map(([, shown]) => shown);
    [...who.ids].forEach((id) => { if (theirIds.has(id)) { const p = pan.find((x) => x.userId === id); if (p && !shared.includes(p.name)) shared.push(p.name); } });
    const inDay = new Date(r.interviewAt) >= dayStart && new Date(r.interviewAt) < dayEnd;
    const base = { at: r.interviewAt, time: istTime(r.interviewAt), ...label(r) };
    if (shared.length && inDay) booked.push({ ...base, interviewers: shared, clash: !!near(r.interviewAt) });
    if (near(r.interviewAt)) {
      shared.forEach((name) => clashes.push({ kind: 'interviewer', who: name, ...base }));
      if (r.candidateId === app.candidateId) clashes.push({ kind: 'candidate', who: app.candidate ? app.candidate.name : 'The candidate', ...base, candidate: app.candidate ? app.candidate.name : null });
    }
  });
  booked.sort((a, b) => new Date(a.at) - new Date(b.at));

  // Free times that day (09:00 - 19:00, every 30 minutes) when none of the interviewers is booked within the hour.
  const busy = booked.map((b) => new Date(b.at).getTime());
  const freeTimes = [];
  for (let m = 9 * 60; m <= 19 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const slot = new Date(`${date}T${hh}:${mm}:00+05:30`).getTime();
    if (slot < Date.now()) continue; // eslint-disable-line no-continue
    if (!busy.some((b) => Math.abs(b - slot) < WINDOW_MIN * 60000)) freeTimes.push(`${hh}:${mm}`);
  }
  const words = clashes.map((c) => (c.kind === 'candidate'
    ? `${c.who} already has an interview at ${c.time}${c.job ? ` (${c.job})` : ''}.`
    : `${c.who} already has an interview at ${c.time}${c.candidate && c.candidate !== 'Another interview' ? ` with ${c.candidate}` : ''}.`));
  return {
    at: at ? at.toISOString() : null, windowMinutes: WINDOW_MIN, interviewers: [...who.names.values()], clashes, booked, freeTimes,
    warning: words.length ? `Clash: ${words.join(' ')}` : null,
  };
}

module.exports = { check, WINDOW_MIN };
