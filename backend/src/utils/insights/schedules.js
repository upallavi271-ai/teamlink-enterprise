// ---------------------------------------------------------------------------
// SCHEDULED DASHBOARD + REPORT E-MAILS (01.14 / 12.04, 2026-11-21).
//
// A person schedules "my dashboard" or one of their saved reports daily / weekly / monthly at an hour (India time) to
// themselves - a team lead / manager / admin also to people of their area. EACH RECIPIENT GETS THEIR OWN NUMBERS: the mail
// is built in the recipient's scope, never the sender's, so a schedule cannot carry data to someone who may not see it.
// OFF BY DEFAULT: nothing is sent until an Admin switches "Scheduled e-mails" on (core.switches().schedules). In the test
// sandbox the mailer never opens a socket (utils/sandbox.js).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');
const M = require('./metrics');
const B = require('./builder');
const S = require('./saved');
const A = require('./alerts');
const { atsScopeOf } = require('../scope');

const FREQ = ['daily', 'weekly', 'monthly'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const IST = 330 * 60000;

// The next time (UTC ISO) a schedule is due after `after`.
function nextDue(s, after = new Date()) {
  const hour = Math.max(0, Math.min(23, Number(s.hour) || 9));
  const base = new Date(after.getTime() + IST); // "now" in India, as a UTC-shaped date
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i, hour, 0, 0));
    const at = new Date(d.getTime() - IST);
    if (at <= after) continue; // eslint-disable-line no-continue
    if (s.frequency === 'weekly' && d.getUTCDay() !== (Number(s.weekday) || 1)) continue; // eslint-disable-line no-continue
    if (s.frequency === 'monthly' && d.getUTCDate() !== Math.max(1, Math.min(28, Number(s.monthDay) || 1))) continue; // eslint-disable-line no-continue
    return at.toISOString();
  }
  return null;
}
const when = (s) => (s.frequency === 'daily' ? `Every day at ${s.hour}:00` : s.frequency === 'weekly' ? `Every ${WEEKDAYS[Number(s.weekday) || 1]} at ${s.hour}:00` : `On day ${s.monthDay || 1} of every month at ${s.hour}:00`);

// Who this person may send to: themselves; a lead / admin also active ATS people of their area.
async function mayRecipients(user) {
  const acc = await C.access(user);
  if (!acc.lead) return [{ id: user.id, name: user.name, email: user.email }];
  const s = atsScopeOf(user);
  const where = { status: 'Active', atsAccess: true };
  if (!acc.admin && !s.global) where.atsDepartment = { in: s.departments && s.departments.length ? s.departments : ['__none__'] };
  const rows = await prisma.user.findMany({ where, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' }, take: 500 });
  if (!rows.some((r) => r.id === user.id)) rows.unshift({ id: user.id, name: user.name, email: user.email });
  return rows;
}

async function list(user) {
  await C.ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsReportSchedule" WHERE "userId" = ? ORDER BY "createdAt"', user.id);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => String(r.recipientIds || '').split(',').filter(Boolean)))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const reports = new Map((await S.visible(user)).map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, reportId: r.reportId, reportName: r.kind === 'report' ? (reports.get(r.reportId) || '(report removed)') : 'My dashboard',
    frequency: r.frequency, weekday: C.num(r.weekday), monthDay: C.num(r.monthDay), hour: Number(r.hour), when: when({ ...r, hour: Number(r.hour) }),
    recipients: String(r.recipientIds || '').split(',').filter(Boolean).map((id) => ({ id, name: names.get(id) || '—' })),
    active: !!Number(r.active), lastSentAt: r.lastSentAt, lastStatus: r.lastStatus, nextDueAt: r.nextDueAt,
  }));
}
async function create(user, body = {}) {
  await C.ensure();
  const kind = body.kind === 'report' ? 'report' : 'dashboard';
  if (kind === 'report' && !(await S.get(user, body.reportId))) return { status: 400, error: 'Pick one of your saved reports.' };
  const frequency = FREQ.includes(body.frequency) ? body.frequency : 'weekly';
  const hour = Math.max(6, Math.min(22, Math.round(Number(body.hour) || 9)));
  const weekday = Math.max(0, Math.min(6, Math.round(Number(body.weekday ?? 1))));
  const monthDay = Math.max(1, Math.min(28, Math.round(Number(body.monthDay) || 1)));
  const allowed = new Map((await mayRecipients(user)).map((r) => [r.id, r]));
  const want = (Array.isArray(body.recipientIds) && body.recipientIds.length ? body.recipientIds : [user.id]).map(String);
  const bad = want.filter((id) => !allowed.has(id));
  if (bad.length) return { status: 403, error: 'You can send only to yourself and people in your own area.' };
  const n = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsReportSchedule" WHERE "userId" = ?', user.id))[0];
  if (Number(n.n) >= 20) return { status: 400, error: 'You can keep 20 schedules. Remove one first.' };
  const id = C.newId('sch');
  const s = { frequency, hour, weekday, monthDay };
  await prisma.$executeRawUnsafe('INSERT INTO "AtsReportSchedule" ("id","userId","userName","kind","reportId","frequency","weekday","monthDay","hour","recipientIds","active","nextDueAt","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)',
    id, user.id, user.name || null, kind, kind === 'report' ? String(body.reportId) : null, frequency, weekday, monthDay, hour, [...new Set(want)].slice(0, 50).join(','), nextDue(s), new Date().toISOString());
  const { logAudit } = require('../audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'ATS scheduled e-mail created', entity: 'AtsReportSchedule', entityId: id, toValue: `${kind} - ${when(s)} - ${want.length} recipient(s)` });
  return { ok: true, id };
}
async function update(user, id, body = {}) {
  await C.ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsReportSchedule" WHERE "id" = ? AND "userId" = ?', String(id), user.id);
  if (!r) return { status: 404, error: 'That schedule is not yours or is gone.' };
  if (typeof body.active === 'boolean') {
    await prisma.$executeRawUnsafe('UPDATE "AtsReportSchedule" SET "active" = ?, "nextDueAt" = ? WHERE "id" = ?', body.active ? 1 : 0, body.active ? nextDue({ ...r, hour: Number(r.hour) }) : r.nextDueAt, r.id);
  }
  return { ok: true };
}
async function remove(user, id) {
  await C.ensure();
  const n = await prisma.$executeRawUnsafe('DELETE FROM "AtsReportSchedule" WHERE "id" = ? AND "userId" = ?', String(id), user.id);
  return n ? { ok: true } : { status: 404, error: 'That schedule is not yours or is gone.' };
}

// --- the mail ---------------------------------------------------------------------------------------
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const table = (headers, rows) => `<table style="border-collapse:collapse;font:13px system-ui,Segoe UI,sans-serif;margin:6px 0 14px">
<tr>${headers.map((h) => `<th style="text-align:left;border-bottom:2px solid #d0d7e2;padding:4px 10px">${esc(h)}</th>`).join('')}</tr>
${rows.map((r) => `<tr>${r.map((c) => `<td style="border-bottom:1px solid #eef1f5;padding:4px 10px">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;

// "My dashboard" for one person, in their own scope.
async function dashboardMail(who) {
  const acc = await C.access(who);
  if (!acc.ok) return null;
  const ctx = await C.ctxFor(who, {}, true);
  const ttf = M.timeToFill(ctx, { days: 90 });
  const rd = M.readiness(ctx, { limit: 5 });
  const fc = await M.forecast(ctx, { money: acc.money });
  const bn = M.bottlenecks(ctx);
  const alerts = await A.checkUser(who, { notify: false }).catch(() => []);
  const lines = [
    `Usual days to fill (last 90 days): ${ttf.tiles.medianFill ?? '-'}  ·  usual days to hire: ${ttf.tiles.medianHire ?? '-'}  ·  joined: ${ttf.tiles.joined}`,
    `Expected joinings from the pipeline now: ${fc.expectedJoinings} (of ${fc.inPipeline} people in process)${fc.revenue ? `  ·  expected fee: Rs ${fc.revenue.expected.toLocaleString('en-IN')}` : ''}`,
    bn.bottleneck.conversion, bn.bottleneck.waiting,
  ].filter(Boolean);
  const html = `<div style="font:14px system-ui,Segoe UI,sans-serif;color:#1b2a4a"><h2 style="margin:0 0 6px">Your ATS dashboard</h2>
<p style="color:#5b6474">${esc(C.today())} · your own area · numbers as TeamLink shows them to you</p>
${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<h3>Closest to being filled</h3>${table(['Requirement', 'Client', 'Ready', 'Left', 'Next step'], rd.rows.map((r) => [r.requirement, r.client, `${r.readiness}%`, r.left, r.next]))}
${alerts.length ? `<h3>Your alerts</h3>${table(['Number', 'Now', 'Your limit'], alerts.map((a) => [a.label, a.value ?? '-', `${a.direction} ${a.threshold}${a.crossed ? ' (crossed)' : ''}`]))}` : ''}
<p style="color:#8a93a3;font-size:12px">You get this because a schedule was set up in TeamLink (Reports &amp; Team &gt; Reports &gt; Build &amp; schedule). Open TeamLink to change or stop it.</p></div>`;
  return { subject: `Your ATS dashboard - ${C.today()}`, text: lines.join('\n'), html, attachments: [] };
}
async function reportMail(who, reportId, ownerName) {
  const acc = await C.access(who);
  if (!acc.ok) return null;
  const R = await S.get(who, reportId);
  const owner = R || null;
  let spec = owner && owner.spec;
  if (!spec) {
    // the recipient may not see the saved report itself (it is the sender's private one): it is read for its question only
    const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsSavedReport" WHERE "id" = ?', String(reportId));
    if (!row) return null;
    try { spec = JSON.parse(row.spec); } catch { return null; }
  }
  const { spec: clean } = B.clean(spec);
  const out = await B.run(who, clean);
  const headers = out.groups ? [out.groupBy.label, out.measure.label] : out.columns.map((c) => c.label);
  const rows = out.groups ? out.groups.map((g) => [g.label, g.value]) : out.rows;
  const { toXlsx } = require('../tabularExport'); // eslint-disable-line global-require
  const name = (owner && owner.name) || out.title;
  const html = `<div style="font:14px system-ui,Segoe UI,sans-serif;color:#1b2a4a"><h2 style="margin:0 0 6px">${esc(name)}</h2>
<p style="color:#5b6474">${esc(out.title)} · ${out.total} row(s) · your own area${ownerName ? ` · scheduled by ${esc(ownerName)}` : ''}</p>
${table(headers, rows.slice(0, 25))}${rows.length > 25 ? `<p>… and ${rows.length - 25} more in the attached Excel file.</p>` : ''}
<p style="color:#8a93a3;font-size:12px">Built in your own scope: you see only what TeamLink shows you.</p></div>`;
  return {
    subject: `${name} - ${C.today()}`, text: `${name}\n${out.title}\n${out.total} row(s). The table is in the attached Excel file.`, html,
    attachments: [{ filename: `${String(name).replace(/[^\w.-]+/g, '-').slice(0, 60)}.xlsx`, content: toXlsx(headers, rows, 'Report') }],
  };
}

async function sendOne(s) {
  const { sendMail } = require('../mailer'); // eslint-disable-line global-require
  const ids = String(s.recipientIds || '').split(',').filter(Boolean);
  const results = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const who = await C.identityOf(id);
    if (!who) { results.push('left'); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const mail = s.kind === 'report' ? await reportMail(who, s.reportId, s.userName).catch(() => null) : await dashboardMail(who).catch(() => null);
    if (!mail) { results.push('no access'); continue; } // eslint-disable-line no-continue
    const email = who.email;
    if (!email) { results.push('no e-mail'); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const r = await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html, attachments: mail.attachments, useEmployeeFrom: false, fromName: 'TeamLink Reports' });
    results.push(r.ok ? 'sent' : (r.notConfigured ? 'e-mail not set up' : 'failed'));
  }
  const sent = results.filter((r) => r === 'sent').length;
  const status = `${sent} of ${ids.length} sent${results.some((r) => r !== 'sent') ? ` (${[...new Set(results.filter((r) => r !== 'sent'))].join(', ')})` : ''}`;
  await prisma.$executeRawUnsafe('UPDATE "AtsReportSchedule" SET "lastSentAt" = ?, "lastStatus" = ?, "nextDueAt" = ? WHERE "id" = ?',
    new Date().toISOString(), status, nextDue({ ...s, hour: Number(s.hour) }), s.id);
  return { id: s.id, status, results };
}

async function sweep({ now = new Date() } = {}) {
  const sw = await C.switches();
  if (!sw.schedules) return { skipped: 'Scheduled e-mails are switched off.' };
  await C.ensure();
  const due = await prisma.$queryRawUnsafe('SELECT * FROM "AtsReportSchedule" WHERE "active" = 1 AND "nextDueAt" IS NOT NULL AND "nextDueAt" <= ? LIMIT 50', now.toISOString());
  const out = [];
  for (const s of due) out.push(await sendOne(s)); // eslint-disable-line no-await-in-loop
  return { sent: out };
}
let TIMER = null;
function startSweep() {
  if (TIMER || require('../sandbox').isSandbox()) return; // eslint-disable-line global-require
  TIMER = setInterval(() => { sweep().catch((e) => console.error('[insights schedules]', e.message)); }, 15 * 60000); // eslint-disable-line no-console
  if (TIMER.unref) TIMER.unref();
}

module.exports = { list, create, update, remove, sweep, startSweep, nextDue, mayRecipients, dashboardMail, reportMail, sendOne };
