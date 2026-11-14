// ---------------------------------------------------------------------------
// AI MARKETING > REPORTS (2026-11-14, module 6 "Analytics & Reporting"). One page of plain numbers for a date range (India time): AI Content, pictures / videos / clips,
// the Content Calendar, client approvals and AI use, with a CSV download. Read only: it counts what the other modules already store.
//   who    Admin and Marketing (mayAiMarketing); a Marketing login sees its own departments' rows, an Admin sees everything.
//   notes  "decided" counts use each item's CURRENT status, so an approved item that was edited later (and is a draft again) is not counted as approved.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');

const IST = 19800000;
const DAY = 86400000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const dayStart = (d) => Date.parse(`${d}T00:00:00+05:30`);
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const mine = (u, r) => A.isAdmin(u) || A.mayDepartment(u, r.department || '');

// "7d" | "30d" | "month" | "lastmonth" | "custom" (+ from, to as YYYY-MM-DD) -> { from, to (exclusive), label }
function rangeOf(q = {}) {
  const now = Date.now(); const today = istDay(now);
  const t0 = dayStart(today);
  const key = String(q.range || '30d');
  if (key === '7d') return { key, from: t0 - 6 * DAY, to: t0 + DAY };
  if (key === 'month') {
    // the whole month, so posts planned for the rest of it count as "still to come"
    const [y, mo] = today.split('-').map(Number);
    return { key, from: dayStart(`${today.slice(0, 8)}01`), to: dayStart(new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)) };
  }
  if (key === 'lastmonth') {
    const [y, mo] = today.split('-').map(Number); const first = Date.UTC(y, mo - 2, 1); const cur = Date.UTC(y, mo - 1, 1);
    return { key, from: dayStart(new Date(first).toISOString().slice(0, 10)), to: dayStart(new Date(cur).toISOString().slice(0, 10)) };
  }
  if (key === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(String(q.from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) {
    const from = dayStart(q.from); const to = dayStart(q.to) + DAY;
    if (to > from && to - from <= 400 * DAY) return { key, from, to };
  }
  return { key: '30d', from: t0 - 29 * DAY, to: t0 + DAY };
}

async function tableOk(name) { try { await S.q(`SELECT 1 FROM "${name}" LIMIT 1`); return true; } catch { return false; } }
async function rows(name, where, ...args) { return (await tableOk(name)) ? S.q(`SELECT * FROM "${name}" WHERE ${where}`, ...args) : []; }

async function report(u, q = {}) {
  if (!mayWrite(u)) return { error: 'Reports are for Admins and the Marketing team.', status: 403 };
  const { from, to, key } = rangeOf(q);
  const now = Date.now();
  const inR = (v) => S.num(v) >= from && S.num(v) < to;

  // AI Content (words)
  const content = (await rows('OmniMkContent', 'deletedAt IS NULL AND createdAt >= ? AND createdAt < ?', from, to)).filter((r) => mine(u, r));
  const decided = content.filter((r) => r.decidedAt && (r.status === 'approved' || r.status === 'changes'));
  const approvalHrs = content.filter((r) => r.status === 'approved' && r.submittedAt && r.decidedAt).map((r) => S.num(r.decidedAt) - S.num(r.submittedAt)).filter((x) => x >= 0);
  const byChannel = {};
  content.forEach((r) => parse(r.channels, []).forEach((k) => { byChannel[k] = (byChannel[k] || 0) + 1; }));

  // pictures, videos, clips (one table)
  const media = (await rows('OmniMkImage', 'deletedAt IS NULL AND createdAt >= ? AND createdAt < ?', from, to)).filter((r) => mine(u, r));
  const isVid = (r) => /^video\//.test(r.mime || '');
  const m = {
    aiPictures: media.filter((r) => !isVid(r) && r.style !== 'upload').length,
    uploadedPictures: media.filter((r) => !isVid(r) && r.style === 'upload').length,
    videosMade: media.filter((r) => isVid(r) && r.style !== 'clip' && r.model !== 'veo').length,
    clipsUploaded: media.filter((r) => isVid(r) && r.style === 'clip' && r.model !== 'veo').length,
    clipsMadeByAi: media.filter((r) => isVid(r) && r.model === 'veo').length,
    approved: media.filter((r) => r.status === 'approved').length,
    waiting: media.filter((r) => r.status === 'waiting').length,
    sentBack: media.filter((r) => r.status === 'changes').length,
  };

  // Content Calendar: the posts planned inside the range
  const cal = (await rows('OmniMkCalendar', 'deletedAt IS NULL AND at >= ? AND at < ?', from, to)).filter((r) => mine(u, r));
  const open = ['idea', 'planned', 'ready'];
  const byPlatform = {};
  cal.forEach((r) => parse(r.platforms, []).forEach((k) => { const x = byPlatform[k] || (byPlatform[k] = { total: 0, posted: 0 }); x.total += 1; if (r.status === 'posted') x.posted += 1; }));
  const calendar = {
    planned: cal.length, posted: cal.filter((r) => r.status === 'posted').length, skipped: cal.filter((r) => r.status === 'skipped').length,
    overdue: cal.filter((r) => open.includes(r.status) && S.num(r.at) < now).length, upcoming: cal.filter((r) => open.includes(r.status) && S.num(r.at) >= now).length,
    postedLate: cal.filter((r) => r.status === 'posted' && r.postedAt && S.num(r.postedAt) > S.num(r.at) + 3 * 3600000).length,
  };

  // client approvals sent inside the range
  const reviews = (await rows('OmniMkClientReview', 'deletedAt IS NULL AND createdAt >= ? AND createdAt < ?', from, to)).filter((r) => mine(u, r));
  const answered = reviews.filter((r) => r.decidedAt && (r.status === 'approved' || r.status === 'changes'));
  const clients = {
    sent: reviews.length, approved: reviews.filter((r) => r.status === 'approved').length, changes: reviews.filter((r) => r.status === 'changes').length,
    waiting: reviews.filter((r) => r.status === 'sent' && S.num(r.expiresAt) >= now).length, expired: reviews.filter((r) => r.status === 'sent' && S.num(r.expiresAt) < now).length,
    avgResponseHours: avg(answered.map((r) => S.num(r.decidedAt) - S.num(r.createdAt)).filter((x) => x >= 0)),
  };
  clients.avgResponseHours = clients.avgResponseHours == null ? null : hours(clients.avgResponseHours);

  // AI use (the shared usage log): an Admin sees everybody, a Marketing login only the own
  await AI.ensure();
  const own = A.isAdmin(u) ? '' : 'AND userId = ?';
  const uargs = A.isAdmin(u) ? [] : [u.id];
  const usage = await S.q(`SELECT module, task, ok, COUNT(*) AS n FROM "OmniMkAiUsage" WHERE at >= ? AND at < ? ${own} GROUP BY module, task, ok`, from, to, ...uargs);
  const ai = { requests: 0, failed: 0, byTask: [] };
  const tasks = {};
  usage.forEach((x) => { const n = S.num(x.n); const k = `${x.module}/${x.task}`; if (S.num(x.ok) === 1) { ai.requests += n; tasks[k] = (tasks[k] || 0) + n; } else ai.failed += n; });
  ai.byTask = Object.entries(tasks).map(([k, n]) => ({ task: k, n })).sort((a, b) => b.n - a.n);

  // people
  const ppl = {};
  const add = (name, k) => { const n = name || '—'; (ppl[n] || (ppl[n] = { name: n, content: 0, pictures: 0, videos: 0, posts: 0 }))[k] += 1; };
  content.forEach((r) => add(r.createdByName, 'content'));
  media.forEach((r) => add(r.createdByName, isVid(r) ? 'videos' : 'pictures'));
  cal.forEach((r) => add(r.createdByName, 'posts'));
  const people = Object.values(ppl).map((p) => ({ ...p, total: p.content + p.pictures + p.videos + p.posts })).sort((a, b) => b.total - a.total).slice(0, 10);

  return {
    range: { key, from: istDay(from), to: istDay(to - DAY), days: Math.round((to - from) / DAY) },
    content: {
      created: content.length, waiting: content.filter((r) => r.status === 'waiting').length, approved: content.filter((r) => r.status === 'approved').length, sentBack: content.filter((r) => r.status === 'changes').length,
      decided: decided.length, avgApprovalHours: approvalHrs.length ? hours(avg(approvalHrs)) : null, byChannel: Object.entries(byChannel).map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
    },
    media: m, calendar, byPlatform: Object.entries(byPlatform).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.total - a.total), clients, ai, people,
    scope: A.isAdmin(u) ? 'all' : 'department',
  };
}

const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
async function csv(u, query = {}) {
  const r = await report(u, query);
  if (r.error) return r;
  const L = [['Section', 'Item', 'Value']];
  const add = (sec, item, v) => L.push([sec, item, v == null ? '' : v]);
  add('Range', 'From', r.range.from); add('Range', 'To', r.range.to);
  Object.entries({ 'Written': r.content.created, 'Waiting for approval': r.content.waiting, 'Approved': r.content.approved, 'Sent back': r.content.sentBack, 'Average hours to approve': r.content.avgApprovalHours }).forEach(([k, v]) => add('AI Content', k, v));
  r.content.byChannel.forEach((x) => add('AI Content by channel', x.key, x.n));
  Object.entries({ 'AI pictures made': r.media.aiPictures, 'Pictures uploaded': r.media.uploadedPictures, 'Videos made': r.media.videosMade, 'Clips uploaded': r.media.clipsUploaded, 'Clips made by AI': r.media.clipsMadeByAi, 'Approved': r.media.approved, 'Waiting for approval': r.media.waiting, 'Sent back': r.media.sentBack }).forEach(([k, v]) => add('Pictures and videos', k, v));
  Object.entries({ 'Posts planned': r.calendar.planned, 'Posted': r.calendar.posted, 'Skipped': r.calendar.skipped, 'Overdue': r.calendar.overdue, 'Still to come': r.calendar.upcoming, 'Posted more than 3 hours late': r.calendar.postedLate }).forEach(([k, v]) => add('Content Calendar', k, v));
  r.byPlatform.forEach((x) => add('Calendar by platform', `${x.key} (posted of planned)`, `${x.posted} of ${x.total}`));
  Object.entries({ 'Sent': r.clients.sent, 'Approved': r.clients.approved, 'Changes asked': r.clients.changes, 'Waiting': r.clients.waiting, 'Expired': r.clients.expired, 'Average hours to answer': r.clients.avgResponseHours }).forEach(([k, v]) => add('Client approvals', k, v));
  add('AI use', 'Requests that worked', r.ai.requests); add('AI use', 'Requests that failed', r.ai.failed);
  r.ai.byTask.forEach((x) => add('AI use by task', x.task, x.n));
  r.people.forEach((p) => add('People', p.name, `content ${p.content}, pictures ${p.pictures}, videos ${p.videos}, posts ${p.posts}`));
  return { text: `﻿${L.map((row) => row.map(q).join(',')).join('\r\n')}\r\n`, name: `ai-marketing-report-${r.range.from}-to-${r.range.to}.csv` };
}

module.exports = { report, csv, rangeOf };
