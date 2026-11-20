// ---------------------------------------------------------------------------
// CALL LISTS (founder 2026-11-17): "recruiters ki data vastadhi, sheets format lo; aa sheets multiple recruiters ki divide chesi assign chestaru; assign chesaka, recruiters aa
// data lo unna contacts ni VICIdial nundi call chestaru". So:
//
//   a manager uploads the sheet (Excel / CSV)   ->  the contacts become one CALL LIST, split into equal blocks among the recruiters picked
//   each recruiter sees ONLY their own block     ->  one contact at a time: the number big, Copy number (to paste in VICIdial), then how the call went
//   the manager sees progress per recruiter      ->  called / answered / interested / remaining; can move what is left from one recruiter to others; can download the result
//
// The contacts stay a separate list (not ATS candidates): nothing here touches candidates, consent or duplicates there. TeamLink does not dial; VICIdial does
// (the recruiters' own tool). Raw-SQL tables, created the first time they are needed (same pattern as crm/schema.js): nothing existing is altered.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "CallList" (
    "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "fileName" TEXT, "headingsJson" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'Active',
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CallListRow" (
    "id" TEXT NOT NULL PRIMARY KEY, "listId" TEXT NOT NULL, "seq" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT, "phone" TEXT NOT NULL, "e164" TEXT NOT NULL, "phone2" TEXT, "location" TEXT, "interest" TEXT, "extraJson" TEXT,
    "recruiterId" TEXT, "recruiterName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'New', "note" TEXT, "callbackAt" TEXT, "calledCount" INTEGER NOT NULL DEFAULT 0, "lastCalledAt" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "CallListCall" (
    "id" TEXT NOT NULL PRIMARY KEY, "rowId" TEXT NOT NULL, "listId" TEXT NOT NULL, "byId" TEXT, "byName" TEXT,
    "outcome" TEXT NOT NULL, "note" TEXT, "callbackAt" TEXT, "at" TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "CallListRow_list" ON "CallListRow"("listId", "recruiterId", "status")',
  'CREATE INDEX IF NOT EXISTS "CallListCall_row" ON "CallListCall"("rowId")',
];
let done = null;
function ensure() {
  if (done) return done;
  done = (async () => { for (const sql of DDL) await prisma.$executeRawUnsafe(sql); return true; })() // eslint-disable-line no-await-in-loop
    .catch((err) => { done = null; console.error('[call-lists] schema:', err.message); return false; }); // eslint-disable-line no-console
  return done;
}
const nowIso = () => new Date().toISOString();
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
async function all(sql, ...params) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...params)).map(plain); }
async function one(sql, ...params) { return (await all(sql, ...params))[0] || null; }
async function run(sql, ...params) { await ensure(); return prisma.$executeRawUnsafe(sql, ...params); }
const newId = (p) => `${p}_${require('crypto').randomBytes(9).toString('hex')}`; // eslint-disable-line global-require
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const fail = (status, error, more) => ({ status, body: { error, ...(more || {}) } });
const ok = (body) => ({ status: 200, body });

// WHO: managers upload, split and see everyone; everybody else only works their own block.
const MANAGERS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'TL', 'STL'];
const roleOf = (u) => String((u.scopeRoles && u.scopeRoles.ats) || u.atsRole || u.role || '');
const isManager = (u) => MANAGERS.includes(roleOf(u)) || MANAGERS.includes(String(u.role || ''));

// HOW A CALL WENT. PENDING ones are still to call (a no-answer is tried again); the others are finished.
const OUTCOMES = ['Answered', 'Interested', 'Not interested', 'Call back', 'Not answered', 'Busy', 'Switched off', 'Wrong number', 'Do not call'];
const PENDING = ['New', 'Not answered', 'Busy', 'Switched off', 'Call back'];

// ---- the sheet -----------------------------------------------------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const WANT = {
  name: (h) => /^(full )?name$|candidate|^contact name|^person|^student/.test(h),
  phone: (h) => /^(mobile|phone|contact|mob|cell|whatsapp)( ?(no|number|num|nos|1))?$|^(mobile|phone|contact) (no|number)|^mobile$|^phone$/.test(h) && !/2|alt|second|other/.test(h),
  phone2: (h) => /(alt|alternate|second|other|secondary)\b.*(mobile|phone|contact|number|no)|(mobile|phone|contact|number)\b.*(2|two|alt)/.test(h),
  location: (h) => /^(city|location|place|town|district|area|current location|native)/.test(h),
  interest: (h) => /^(role|designation|job|position|vacancy|course|qualification|education|interest|post|department)/.test(h),
};
function columnsOf(heads) {
  const col = {}; const used = new Set();
  for (const key of ['phone2', 'phone', 'name', 'location', 'interest']) { // phone2 first so "Alternate mobile" is not taken as the phone
    const h = heads.find((x) => !used.has(x) && WANT[key](norm(x)));
    if (h) { col[key] = h; used.add(h); }
  }
  return col;
}
function parseSheet(buf) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.read(buf, { type: 'buffer', raw: false, codepage: 65001 });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
}
function phoneOf(raw) {
  const m = require('../utils/messagingCore').normalizeMobile(String(raw || '').split(/[,/;\n]/)[0].trim()); // eslint-disable-line global-require
  return m.ok ? { phone: String(m.e164).replace(/\D/g, '').slice(-10), e164: m.e164 } : null; // the 10 digits the recruiter pastes into VICIdial
}

/** Equal blocks in sheet order: 100 contacts, 3 recruiters -> 34, 33, 33. -> [{ recruiterIndex, from, to }] */
function blocks(n, k) {
  const out = []; let at = 0;
  for (let i = 0; i < k; i += 1) { const size = Math.floor(n / k) + (i < n % k ? 1 : 0); out.push({ i, from: at, to: at + size }); at += size; }
  return out;
}

async function recruiterPick(user) {
  if (!isManager(user)) return fail(403, 'Only a manager or team lead splits call lists.');
  const rows = await prisma.user.findMany({ where: { status: 'Active', atsRole: { in: ['RECRUITER', 'TL', 'STL'] } }, select: { id: true, name: true, atsRole: true, role: true, atsDepartment: true, team: true }, orderBy: { name: 'asc' }, take: 400 });
  return ok({ recruiters: rows.filter((u) => !/zztest|example\.test/i.test(u.name || '')).map((u) => ({ id: u.id, name: u.name, role: u.atsRole || u.role, department: u.atsDepartment || null, team: u.team || null })) });
}

/** Upload: read the sheet, check the numbers, split among the recruiters picked. dryRun only reports. */
async function importList(user, buf, { fileName, listName, recruiterIds, dryRun } = {}) {
  if (!isManager(user)) return fail(403, 'Only a manager or team lead uploads a call sheet.');
  if (!buf || !buf.length) return fail(400, 'Choose an Excel or CSV file.');
  let rows;
  try { rows = parseSheet(buf); } catch { return fail(400, 'This file could not be read. Save it as .xlsx or .csv and try again.'); }
  if (!rows.length) return fail(400, 'The first sheet has no rows under the headings.');
  if (rows.length > 20000) return fail(400, `The file has ${rows.length} rows; upload at most 20,000 at a time.`);
  const heads = Object.keys(rows[0]);
  const col = columnsOf(heads);
  if (!col.phone) return fail(400, 'No phone column found. The heading should be like Mobile, Phone, Contact Number.', { headings: heads });
  const seen = new Set(); const good = []; let invalid = 0; let duplicate = 0; let blank = 0;
  const mapped = new Set(Object.values(col));
  rows.forEach((r) => {
    const raw = r[col.phone];
    if (!String(raw || '').trim()) { blank += 1; return; }
    const p = phoneOf(raw);
    if (!p) { invalid += 1; return; }
    if (seen.has(p.e164)) { duplicate += 1; return; }
    seen.add(p.e164);
    const p2 = col.phone2 ? phoneOf(r[col.phone2]) : null;
    const extra = {}; heads.forEach((h) => { if (!mapped.has(h) && String(r[h] || '').trim()) extra[clip(h, 60)] = clip(r[h], 200); });
    good.push({ name: clip(r[col.name], 120), phone: p.phone, e164: p.e164, phone2: p2 ? p2.phone : null, location: clip(r[col.location], 100), interest: clip(r[col.interest], 140), extra });
  });
  if (!good.length) return fail(400, 'No usable mobile numbers in this file.', { invalid, blank, headings: heads });
  const ids = [...new Set((Array.isArray(recruiterIds) ? recruiterIds : []).map((x) => String(x)).filter(Boolean))];
  let people = [];
  if (ids.length) {
    const found = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true } });
    people = ids.map((id) => found.find((u) => u.id === id)).filter(Boolean);
    if (people.length !== ids.length) return fail(400, 'One of the recruiters picked is not an active user.');
  }
  const plan = people.length ? blocks(good.length, people.length) : [];
  const split = people.map((p, i) => ({ recruiterId: p.id, recruiterName: p.name, count: plan[i].to - plan[i].from }));
  const report = { rows: rows.length, usable: good.length, invalid, duplicate, blank, columns: { name: col.name || null, phone: col.phone, phone2: col.phone2 || null, location: col.location || null, interest: col.interest || null }, extraColumns: heads.filter((h) => !mapped.has(h)), split };
  if (dryRun) return ok({ ok: true, dryRun: true, ...report });
  const id = newId('cl'); const now = nowIso();
  const name = clip(listName, 120) || clip(String(fileName || 'Call list').replace(/\.[a-z0-9]+$/i, ''), 120) || 'Call list';
  await run('INSERT INTO "CallList" ("id","name","fileName","headingsJson","total","status","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)', id, name, clip(fileName, 160), JSON.stringify(heads), good.length, 'Active', user.id, user.name || null, now, now);
  for (let i = 0; i < good.length; i += 1) {
    const g = good[i];
    const who = plan.length ? people[plan.findIndex((b) => i >= b.from && i < b.to)] : null;
    // eslint-disable-next-line no-await-in-loop
    await run('INSERT INTO "CallListRow" ("id","listId","seq","name","phone","e164","phone2","location","interest","extraJson","recruiterId","recruiterName","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', newId('clr'), id, i, g.name || null, g.phone, g.e164, g.phone2, g.location || null, g.interest || null, Object.keys(g.extra).length ? JSON.stringify(g.extra) : null, who ? who.id : null, who ? who.name : null, 'New', now, now);
  }
  await require('../utils/audit').logAudit({ userId: user.id, actorName: user.name, action: 'Call list uploaded and split', entity: 'CallList', entityId: id, toValue: `${name}: ${good.length} contacts, ${people.length} recruiters` }).catch(() => {}); // eslint-disable-line global-require
  return ok({ ok: true, id, name, ...report });
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------------
async function progressOf(listId, onlyRecruiterId) {
  const rows = await all(`SELECT "recruiterId", "recruiterName", "status", COUNT(*) AS "n" FROM "CallListRow" WHERE "listId" = ?${onlyRecruiterId ? ' AND "recruiterId" = ?' : ''} GROUP BY "recruiterId", "recruiterName", "status"`, ...(onlyRecruiterId ? [listId, onlyRecruiterId] : [listId]));
  const by = new Map();
  rows.forEach((r) => {
    const k = r.recruiterId || '';
    if (!by.has(k)) by.set(k, { recruiterId: r.recruiterId || null, recruiterName: r.recruiterName || 'Not given to anyone yet', assigned: 0, called: 0, remaining: 0, answered: 0, interested: 0, notInterested: 0, callBack: 0, byStatus: {} });
    const p = by.get(k);
    p.assigned += r.n; p.byStatus[r.status] = r.n;
    if (r.status === 'New') p.remaining += r.n; else p.called += r.n;
    if (PENDING.includes(r.status) && r.status !== 'New') p.remaining += r.n;
    if (['Answered', 'Interested', 'Not interested', 'Call back'].includes(r.status)) p.answered += r.n;
    if (r.status === 'Interested') p.interested += r.n;
    if (r.status === 'Not interested') p.notInterested += r.n;
    if (r.status === 'Call back') p.callBack += r.n;
  });
  return [...by.values()].sort((a, b) => String(a.recruiterName).localeCompare(String(b.recruiterName)));
}

async function lists(user, q = {}) {
  const mgr = isManager(user);
  let base = await all('SELECT * FROM "CallList" WHERE "status" = \'Active\' ORDER BY "createdAt" DESC LIMIT 200');
  // FILTERS (2026-11-18): source = the list's name or file, from / to = the day it was made, owner = a recruiter holding a block of it
  const src = clip(q.source, 60).toLowerCase();
  if (src) base = base.filter((l) => `${l.name || ''} ${l.fileName || ''}`.toLowerCase().includes(src));
  if (q.from) base = base.filter((l) => String(l.createdAt).slice(0, 10) >= String(q.from));
  if (q.to) base = base.filter((l) => String(l.createdAt).slice(0, 10) <= String(q.to));
  const out = [];
  for (const l of base) {
    // eslint-disable-next-line no-await-in-loop
    const prog = await progressOf(l.id, mgr ? null : user.id);
    if (mgr && q.owner && !prog.some((p) => p.recruiterId === q.owner)) continue;
    if (!mgr && !prog.length) continue; // a recruiter sees only the lists that hold a block of theirs
    const sum = prog.reduce((a, p) => ({ assigned: a.assigned + p.assigned, called: a.called + p.called, remaining: a.remaining + p.remaining, interested: a.interested + p.interested }), { assigned: 0, called: 0, remaining: 0, interested: 0 });
    out.push({ id: l.id, name: l.name, fileName: l.fileName, total: l.total, createdAt: l.createdAt, createdByName: l.createdByName, recruiters: mgr ? prog.length : undefined, ...sum });
  }
  return ok({ lists: out, canManage: mgr });
}

async function detail(user, listId) {
  const l = await one('SELECT * FROM "CallList" WHERE "id" = ?', clip(listId, 60));
  if (!l) return fail(404, 'This call list is not there.');
  const mgr = isManager(user);
  const progress = await progressOf(l.id, mgr ? null : user.id);
  if (!mgr && !progress.length) return fail(404, 'This call list is not there.');
  return ok({ list: { id: l.id, name: l.name, fileName: l.fileName, total: l.total, createdAt: l.createdAt, createdByName: l.createdByName }, progress, canManage: mgr, outcomes: OUTCOMES });
}

const shapeRow = (r) => { let extra = null; try { extra = r.extraJson ? JSON.parse(r.extraJson) : null; } catch { extra = null; } const { extraJson, ...rest } = r; void extraJson; return { ...rest, extra }; };

async function rows(user, listId, q = {}) {
  const l = await one('SELECT "id" FROM "CallList" WHERE "id" = ?', clip(listId, 60));
  if (!l) return fail(404, 'This call list is not there.');
  const mgr = isManager(user);
  const where = ['"listId" = ?']; const params = [l.id];
  // several recruiters / call results at once (founder 2026-11-20: checkboxes everywhere); a recruiter is always held to their own rows
  const MP = require('../utils/multiParam'); // eslint-disable-line global-require
  const recs = MP.parseMulti(q.recruiter).map((v) => clip(v, 60));
  if (!mgr) { where.push('"recruiterId" = ?'); params.push(user.id); } else if (recs.length) {
    const ids = recs.filter((v) => v !== 'none');
    const or = [...(ids.length ? [`"recruiterId" IN (${ids.map(() => '?').join(',')})`] : []), ...(recs.includes('none') ? ['"recruiterId" IS NULL'] : [])];
    where.push(`(${or.join(' OR ')})`); params.push(...ids);
  }
  const outs = MP.parseMulti(q.outcome).map((v) => clip(v, 40));
  if (outs.length) { where.push(`"status" IN (${outs.map(() => '?').join(',')})`); params.push(...outs); }
  if (q.status === 'pending') where.push(`"status" IN (${PENDING.map(() => '?').join(',')})`) && params.push(...PENDING);
  else if (q.status === 'done') where.push(`"status" NOT IN (${PENDING.map(() => '?').join(',')})`) && params.push(...PENDING);
  else if (q.status) { where.push('"status" = ?'); params.push(clip(q.status, 40)); }
  // FILTERS (2026-11-18): location, interest (what they want), the day it was added (cFrom / cTo), called yes / no
  if (q.location) { where.push('"location" LIKE ?'); params.push(`%${clip(q.location, 60)}%`); }
  if (q.interest) { where.push('"interest" LIKE ?'); params.push(`%${clip(q.interest, 60)}%`); }
  if (q.cFrom) { where.push('substr("createdAt", 1, 10) >= ?'); params.push(clip(q.cFrom, 10)); }
  if (q.cTo) { where.push('substr("createdAt", 1, 10) <= ?'); params.push(clip(q.cTo, 10)); }
  if (q.called === 'yes') where.push('"calledCount" > 0'); else if (q.called === 'no') where.push('"calledCount" = 0');
  if (q.q) { const like = `%${clip(q.q, 60)}%`; where.push('("name" LIKE ? OR "phone" LIKE ? OR "location" LIKE ? OR "interest" LIKE ?)'); params.push(like, like, like, like); }
  const page = Math.max(1, Number(q.page) || 1); const size = Math.min(200, Math.max(10, Number(q.size) || 50));
  const total = (await one(`SELECT COUNT(*) AS "n" FROM "CallListRow" WHERE ${where.join(' AND ')}`, ...params)).n;
  const list = await all(`SELECT * FROM "CallListRow" WHERE ${where.join(' AND ')} ORDER BY "seq" ASC LIMIT ${size} OFFSET ${(page - 1) * size}`, ...params);
  return ok({ rows: list.map(shapeRow), total, page, size });
}

/** The next contact for THIS recruiter to call: a call-back that is due first, then the ones never called, then the no-answers. */
async function next(user, listId) {
  const l = await one('SELECT "id" FROM "CallList" WHERE "id" = ?', clip(listId, 60));
  if (!l) return fail(404, 'This call list is not there.');
  const now = nowIso();
  const mine = '"listId" = ? AND "recruiterId" = ?';
  const p = [l.id, user.id];
  const due = await one(`SELECT * FROM "CallListRow" WHERE ${mine} AND "status" = 'Call back' AND ("callbackAt" IS NULL OR "callbackAt" <= ?) ORDER BY "callbackAt" ASC LIMIT 1`, ...p, now);
  const fresh = due || await one(`SELECT * FROM "CallListRow" WHERE ${mine} AND "status" = 'New' ORDER BY "seq" ASC LIMIT 1`, ...p);
  const retry = fresh || await one(`SELECT * FROM "CallListRow" WHERE ${mine} AND "status" IN ('Not answered','Busy','Switched off') ORDER BY "lastCalledAt" ASC LIMIT 1`, ...p);
  const left = (await one(`SELECT COUNT(*) AS "n" FROM "CallListRow" WHERE ${mine} AND "status" IN (${PENDING.map(() => '?').join(',')})`, ...p, ...PENDING)).n;
  return ok({ row: retry ? shapeRow(retry) : null, left });
}

/** How a call went. Only the recruiter the contact is given to (or a manager) writes it. */
async function logCall(user, rowId, { outcome, note, callbackAt } = {}) {
  if (!OUTCOMES.includes(outcome)) return fail(400, 'Pick how the call went.');
  const r = await one('SELECT * FROM "CallListRow" WHERE "id" = ?', clip(rowId, 60));
  if (!r || (!isManager(user) && r.recruiterId !== user.id)) return fail(404, 'This contact is not there, or it is not yours.');
  let when = null;
  if (outcome === 'Call back') {
    when = callbackAt ? new Date(callbackAt) : null;
    if (!when || Number.isNaN(when.getTime())) return fail(400, 'Pick when to call back.');
    when = when.toISOString();
  }
  const now = nowIso();
  await run('UPDATE "CallListRow" SET "status" = ?, "note" = ?, "callbackAt" = ?, "calledCount" = "calledCount" + 1, "lastCalledAt" = ?, "updatedAt" = ? WHERE "id" = ?', outcome, clip(note, 600) || r.note || null, when, now, now, r.id);
  await run('INSERT INTO "CallListCall" ("id","rowId","listId","byId","byName","outcome","note","callbackAt","at") VALUES (?,?,?,?,?,?,?,?,?)', newId('clc'), r.id, r.listId, user.id, user.name || null, outcome, clip(note, 600) || null, when, now);
  return ok({ ok: true, row: shapeRow(await one('SELECT * FROM "CallListRow" WHERE "id" = ?', r.id)) });
}

/** A manager moves what is still to call from one recruiter (or from nobody) to others, in equal blocks. */
async function reassign(user, listId, { fromId, toIds } = {}) {
  if (!isManager(user)) return fail(403, 'Only a manager or team lead moves contacts between recruiters.');
  const l = await one('SELECT "id" FROM "CallList" WHERE "id" = ?', clip(listId, 60));
  if (!l) return fail(404, 'This call list is not there.');
  const ids = [...new Set((Array.isArray(toIds) ? toIds : []).map(String).filter(Boolean))];
  if (!ids.length) return fail(400, 'Pick at least one recruiter to give them to.');
  const found = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true } });
  const people = ids.map((id) => found.find((u) => u.id === id)).filter(Boolean);
  if (people.length !== ids.length) return fail(400, 'One of the recruiters picked is not an active user.');
  const from = fromId === 'none' || !fromId ? null : String(fromId);
  const left = await all(`SELECT "id" FROM "CallListRow" WHERE "listId" = ? AND ${from ? '"recruiterId" = ?' : '"recruiterId" IS NULL'} AND "status" IN (${PENDING.map(() => '?').join(',')}) ORDER BY "seq" ASC`, ...(from ? [l.id, from] : [l.id]), ...PENDING);
  if (!left.length) return fail(400, 'There is nothing left to give: every contact there is already called.');
  const plan = blocks(left.length, people.length); const now = nowIso();
  for (const b of plan) {
    for (let i = b.from; i < b.to; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await run('UPDATE "CallListRow" SET "recruiterId" = ?, "recruiterName" = ?, "updatedAt" = ? WHERE "id" = ?', people[b.i].id, people[b.i].name, now, left[i].id);
    }
  }
  await require('../utils/audit').logAudit({ userId: user.id, actorName: user.name, action: 'Call list contacts moved', entity: 'CallList', entityId: l.id, toValue: `${left.length} contacts to ${people.map((p) => p.name).join(', ')}` }).catch(() => {}); // eslint-disable-line global-require
  return ok({ ok: true, moved: left.length, split: people.map((p, i) => ({ recruiterId: p.id, recruiterName: p.name, count: plan[i].to - plan[i].from })) });
}

async function exportCsv(user, listId) {
  if (!isManager(user)) return fail(403, 'Only a manager or team lead downloads the result.');
  const l = await one('SELECT * FROM "CallList" WHERE "id" = ?', clip(listId, 60));
  if (!l) return fail(404, 'This call list is not there.');
  const list = await all('SELECT * FROM "CallListRow" WHERE "listId" = ? ORDER BY "seq" ASC', l.id);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Name', 'Phone', 'Alternate phone', 'Location', 'Role / interest', 'Recruiter', 'Status', 'Times called', 'Last called', 'Call back at', 'Note'];
  const lines = [head.map(q).join(',')].concat(list.map((r) => [r.name, r.phone, r.phone2, r.location, r.interest, r.recruiterName, r.status, r.calledCount, r.lastCalledAt, r.callbackAt, r.note].map(q).join(',')));
  return { status: 200, csv: `﻿${lines.join('\r\n')}`, name: `${String(l.name).replace(/[^\w.-]+/g, '_')}-result.csv` };
}

async function closeList(user, listId) {
  if (!isManager(user)) return fail(403, 'Only a manager or team lead closes a call list.');
  const n = await run('UPDATE "CallList" SET "status" = \'Closed\', "updatedAt" = ? WHERE "id" = ? AND "status" = \'Active\'', nowIso(), clip(listId, 60));
  return n ? ok({ ok: true }) : fail(404, 'This call list is not there.');
}

module.exports = { ensure, isManager, importList, recruiterPick, lists, detail, rows, next, logCall, reassign, exportCsv, closeList, blocks, columnsOf, OUTCOMES, PENDING };
