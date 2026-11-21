// ---------------------------------------------------------------------------
// SAVED REPORTS + DASHBOARD CHARTS (12.02 / 01.15, 2026-11-21).
//
//   A saved report = a name + a builder spec (builder.clean). Private, or shared with the owner's team (their ATS
//   department). A shared report RUNS IN EACH VIEWER'S OWN SCOPE (builder.run), so sharing a report shares the question,
//   never the owner's data.
//   A pin puts a saved report on the ATS dashboard as a chart card ("My charts"). A team lead / manager / admin can pin a
//   report for the whole team: it shows on every team member's dashboard (each with their own numbers). The cards move
//   and hide with the dashboard's own Customise (CardLayout.jsx), so the layout is saved per person.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');
const B = require('./builder');
const { logAudit } = require('../audit');

const shape = (r, user) => {
  let spec = {};
  try { spec = JSON.parse(r.spec); } catch { spec = {}; }
  return {
    id: r.id, name: r.name, ownerId: r.ownerId, ownerName: r.ownerName, shared: r.shared, teamKey: r.teamKey, spec,
    mine: r.ownerId === user.id, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
};
async function visible(user) {
  await C.ensure();
  const acc = await C.access(user);
  const team = C.teamKeyOf(user);
  const rows = acc.admin
    ? await prisma.$queryRawUnsafe('SELECT * FROM "AtsSavedReport" WHERE "ownerId" = ? OR "shared" = \'team\' ORDER BY "updatedAt" DESC LIMIT 300', user.id)
    : await prisma.$queryRawUnsafe('SELECT * FROM "AtsSavedReport" WHERE "ownerId" = ? OR ("shared" = \'team\' AND "teamKey" = ?) ORDER BY "updatedAt" DESC LIMIT 300', user.id, team || '__none__');
  return rows.map((r) => shape(r, user));
}
async function get(user, id) {
  const list = await visible(user);
  return list.find((r) => r.id === String(id)) || null;
}
async function save(user, body = {}) {
  await C.ensure();
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) return { status: 400, error: 'Give the report a name.' };
  const { spec } = B.clean(body.spec || {});
  const shared = body.shared === 'team' ? 'team' : 'private';
  const team = C.teamKeyOf(user);
  if (shared === 'team' && !team) return { status: 400, error: 'You are not in a team yet, so this report cannot be shared with one.' };
  const now = new Date().toISOString();
  if (body.id) {
    const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsSavedReport" WHERE "id" = ?', String(body.id));
    if (!r || r.ownerId !== user.id) return { status: 403, error: 'Only the person who made this report can change it. Save a copy instead.' };
    await prisma.$executeRawUnsafe('UPDATE "AtsSavedReport" SET "name" = ?, "spec" = ?, "shared" = ?, "teamKey" = ?, "updatedAt" = ? WHERE "id" = ?', name, JSON.stringify(spec), shared, team, now, r.id);
    return { ok: true, id: r.id };
  }
  const n = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsSavedReport" WHERE "ownerId" = ?', user.id))[0];
  if (Number(n.n) >= 100) return { status: 400, error: 'You can keep 100 saved reports. Delete one first.' };
  const id = C.newId('rpt');
  await prisma.$executeRawUnsafe('INSERT INTO "AtsSavedReport" ("id","ownerId","ownerName","name","spec","shared","teamKey","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)',
    id, user.id, user.name || null, name, JSON.stringify(spec), shared, team, now, now);
  if (shared === 'team') await logAudit({ userId: user.id, actorName: user.name, action: 'ATS report shared with the team', entity: 'AtsSavedReport', entityId: id, toValue: `${name} - team ${team}` });
  return { ok: true, id };
}
async function remove(user, id) {
  await C.ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsSavedReport" WHERE "id" = ?', String(id));
  if (!r) return { status: 404, error: 'That report is gone.' };
  const acc = await C.access(user);
  if (r.ownerId !== user.id && !acc.admin) return { status: 403, error: 'Only the person who made this report (or an Admin) can delete it.' };
  await prisma.$executeRawUnsafe('DELETE FROM "AtsSavedReport" WHERE "id" = ?', r.id);
  await prisma.$executeRawUnsafe('DELETE FROM "AtsDashPin" WHERE "reportId" = ?', r.id);
  await prisma.$executeRawUnsafe('UPDATE "AtsReportSchedule" SET "active" = 0, "lastStatus" = ? WHERE "reportId" = ?', 'Stopped: the report was deleted', r.id);
  return { ok: true };
}

// --- pins -----------------------------------------------------------------------------------------
async function pins(user) {
  await C.ensure();
  const team = C.teamKeyOf(user);
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsDashPin" WHERE "userId" = ? OR ("forTeam" = 1 AND "teamKey" = ?) ORDER BY "position", "createdAt"', user.id, team || '__none__');
  const reports = new Map((await visible(user)).map((r) => [r.id, r]));
  const seen = new Set();
  return rows.filter((p) => { if (seen.has(p.reportId) || !reports.has(p.reportId)) return false; seen.add(p.reportId); return true; })
    .map((p) => ({ id: p.id, reportId: p.reportId, forTeam: !!Number(p.forTeam), mine: p.userId === user.id, report: reports.get(p.reportId) }));
}
async function pin(user, body = {}) {
  await C.ensure();
  const r = await get(user, body.reportId);
  if (!r) return { status: 404, error: 'That report is not yours or shared with you.' };
  const acc = await C.access(user);
  const forTeam = !!body.forTeam;
  if (forTeam && !acc.lead) return { status: 403, error: 'Only a team lead, manager or admin can put a chart on the whole team\'s dashboard.' };
  if (forTeam && r.shared !== 'team') return { status: 400, error: 'Share the report with the team first, then pin it for the team.' };
  const n = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsDashPin" WHERE "userId" = ?', user.id))[0];
  if (Number(n.n) >= 12) return { status: 400, error: 'Your dashboard holds 12 charts. Remove one first.' };
  const dup = await prisma.$queryRawUnsafe('SELECT "id" FROM "AtsDashPin" WHERE "userId" = ? AND "reportId" = ? AND "forTeam" = ?', user.id, r.id, forTeam ? 1 : 0);
  if (dup.length) return { ok: true, id: dup[0].id };
  const id = C.newId('pin');
  await prisma.$executeRawUnsafe('INSERT INTO "AtsDashPin" ("id","userId","reportId","forTeam","teamKey","position","createdAt") VALUES (?,?,?,?,?,?,?)',
    id, user.id, r.id, forTeam ? 1 : 0, forTeam ? C.teamKeyOf(user) : null, Number(n.n), new Date().toISOString());
  return { ok: true, id };
}
async function unpin(user, id) {
  await C.ensure();
  const n = await prisma.$executeRawUnsafe('DELETE FROM "AtsDashPin" WHERE "id" = ? AND "userId" = ?', String(id), user.id);
  return n ? { ok: true } : { status: 404, error: 'Only the person who pinned this chart can remove it (you can hide it with Customise).' };
}

module.exports = { visible, get, save, remove, pins, pin, unpin };
