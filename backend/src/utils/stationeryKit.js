// ---------------------------------------------------------------------------
// THE DEFAULT STATIONERY KIT (user, 2026-10-09: "every active employee gets one
// notepad and one pen by default").
//
//   SETTING   AppSetting 'stationery.defaultKit' = { on, lines:[{itemId,name,quantity}],
//             autoFrom }. Default: ON, Notepad 1 + Pen 1. HR / Admin edit it on
//             Employee Services -> Assets & Stationery -> Stationery. No migration.
//   AUTOMATIC a NEW employee (created in the app, by import, or hired from the ATS)
//             or one who becomes Active again gets the kit ONCE: hooks at those
//             places call onActive(), and a sweep (every 10 minutes, real server
//             only) catches anybody created since the kit was switched on.
//   ONCE      the marker is a StationeryIssue row with batchId 'default-kit' and
//             note 'Default kit' for that employee + item (even if it was later
//             taken back): the kit is never given a second time.
//   WHO       ACTIVE people only (status Active or On Probation). Notice Period,
//             Exit Process, Relieved and Exited people are never auto-issued
//             (somebody on notice who already has it keeps it). The system
//             Super Admin account is not an employee. The sweep, the preview and
//             the bulk button leave test logins out; onActive() does not.
//   STOCK     a kit issue does NOT need stock: the real quantity is entered by
//             the user. The stock tiles then say "N issued, stock not entered yet".
//   BULK      "Give the default kit to everyone who is missing it": preview ->
//             confirm -> apply; the rows of the last run can be undone (only if
//             none of them was taken back since).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { withoutSystemAccounts } = require('./systemAccounts');

const KEY = 'stationery.defaultKit';
const LAST_RUN = 'stationery.defaultKit.lastRun';
const BATCH = 'default-kit';
const NOTE = 'Default kit';
const ACTIVE = ['Active', 'On Probation'];
const TEST_RE = /zztest|example\.test/i;
const DEFAULT_LINES = [{ name: 'Notepad', quantity: 1 }, { name: 'Pen', quantity: 1 }];
const today = () => new Date().toLocaleDateString('en-CA');

const ready = () => !!(prisma.stationeryItem && prisma.stationeryIssue && prisma.appSetting);
const plural = (name, n) => {
  const w = String(name || '').toLowerCase();
  if (n === 1 || /s$/.test(w)) return w;
  if (/(x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
};
const countOf = (name, n) => `${n} ${plural(name, n)}`;

async function readRow(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
async function writeRow(key, value, who) {
  const data = { value: JSON.stringify(value), updatedById: who && who.id ? who.id : null, updatedByName: who && who.name ? who.name : 'System' };
  await prisma.appSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
}

// The setting, created on first use (ON, Notepad 1 + Pen 1, "auto from now").
// `create: false` only LOOKS (a dry run must not write anything).
async function getKit({ create = true } = {}) {
  let k = await readRow(KEY);
  if (!k) {
    k = { on: true, lines: DEFAULT_LINES.map((l) => ({ ...l })), autoFrom: new Date().toISOString() };
    if (create) await writeRow(KEY, k, null);
  }
  return k;
}
// The lines with their item rows resolved (by id, else by name).
async function resolvedLines(kit) {
  const items = await prisma.stationeryItem.findMany();
  return (kit.lines || []).map((l) => {
    const item = items.find((i) => i.id === l.itemId) || items.find((i) => i.name.toLowerCase() === String(l.name || '').toLowerCase());
    return { quantity: Math.max(1, Math.round(Number(l.quantity) || 1)), item: item || null, name: item ? item.name : l.name };
  });
}

async function saveKit({ on, lines }, who) {
  const cur = await getKit();
  const items = await prisma.stationeryItem.findMany();
  const next = { ...cur };
  if (on !== undefined) next.on = !!on;
  if (Array.isArray(lines)) {
    const seen = new Set();
    next.lines = lines.map((l) => {
      const item = items.find((i) => i.id === String(l.itemId || '')) || items.find((i) => i.name.toLowerCase() === String(l.name || '').toLowerCase());
      const q = Number(l.quantity);
      if (!item) throw Object.assign(new Error('Pick an item that is on the stationery list.'), { status: 400 });
      if (!Number.isInteger(q) || q < 1 || q > 50) throw Object.assign(new Error(`${item.name}: the quantity is a whole number from 1 to 50.`), { status: 400 });
      if (seen.has(item.id)) throw Object.assign(new Error(`${item.name} is in the kit twice.`), { status: 400 });
      seen.add(item.id);
      return { itemId: item.id, name: item.name, quantity: q };
    });
    if (!next.lines.length) throw Object.assign(new Error('The kit needs at least one item - or switch it off.'), { status: 400 });
  }
  // Switching on again after it was off: the automatic part starts from now.
  if (cur.on === false && next.on === true) next.autoFrom = new Date().toISOString();
  await writeRow(KEY, next, who);
  await logAudit({ userId: who && who.id, actorName: who && who.name, action: 'Stationery default kit changed', entity: 'AppSetting', entityId: KEY, fromValue: `${cur.on ? 'on' : 'off'}: ${(cur.lines || []).map((l) => `${l.quantity} ${l.name}`).join(' + ')}`, toValue: `${next.on ? 'on' : 'off'}: ${next.lines.map((l) => `${l.quantity} ${l.name}`).join(' + ')}` });
  return next;
}

// Which (employee, item) pairs already carry the marker.
async function markedPairs(employeeIds) {
  const rows = await prisma.stationeryIssue.findMany({ where: { batchId: BATCH, employeeId: { in: employeeIds } }, select: { employeeId: true, itemId: true } });
  return new Set(rows.map((r) => `${r.employeeId}|${r.itemId}`));
}

// Everybody ACTIVE (excluding system accounts; tests optionally), with what they lack.
async function missingPlan({ includeTests = false, peek = false } = {}) {
  const kit = await getKit({ create: !peek });
  const lines = (await resolvedLines(kit)).filter((l) => l.item && l.item.active);
  const where = withoutSystemAccounts({ employmentStatus: { in: ACTIVE } });
  const people = (await prisma.employee.findMany({ where, select: { id: true, employeeCode: true, name: true, email: true, department: true } }))
    .filter((p) => includeTests || !TEST_RE.test(`${p.name} ${p.email || ''}`));
  const marked = await markedPairs(people.map((p) => p.id));
  const need = []; let already = 0;
  people.forEach((p) => {
    const miss = lines.filter((l) => !marked.has(`${p.id}|${l.item.id}`));
    if (miss.length) need.push({ person: p, lines: miss }); else already += 1;
  });
  const what = lines.map((l) => countOf(l.name, l.quantity)).join(' + ');
  return { kit, lines, need, already, people: people.length, what };
}

async function previewAll() {
  const p = await missingPlan();
  return {
    on: p.kit.on, kit: p.lines.map((l) => ({ itemId: l.item.id, name: l.name, quantity: l.quantity })), what: p.what,
    willGet: p.need.length, already: p.already, active: p.people,
    text: p.lines.length ? `${p.need.length} ${p.need.length === 1 ? 'person' : 'people'} will get ${p.what}; ${p.already} already ${p.already === 1 ? 'has' : 'have'} it.` : 'The kit has no item that is on the list right now.',
  };
}

// Give the kit rows to these people (idempotent). Returns the created row ids.
async function giveTo(entries, who, { batchNote = NOTE } = {}) {
  const created = [];
  for (const e of entries) {
    for (const l of e.lines) {
      // eslint-disable-next-line no-await-in-loop
      const dup = await prisma.stationeryIssue.findFirst({ where: { employeeId: e.person.id, itemId: l.item.id, batchId: BATCH }, select: { id: true } });
      if (dup) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.stationeryIssue.create({
        data: { itemId: l.item.id, employeeId: e.person.id, quantity: l.quantity, kind: 'ISSUE', date: today(), note: batchNote, batchId: BATCH, issuedById: who && who.id ? who.id : null, issuedByName: who && who.name ? who.name : 'Default kit (automatic)' },
      });
      created.push(row.id);
    }
  }
  return created;
}

async function applyAll(who) {
  const p = await missingPlan();
  if (!p.kit.on) throw Object.assign(new Error('The default kit is switched off. Switch it on first.'), { status: 409 });
  const ids = await giveTo(p.need, who);
  if (ids.length) {
    await writeRow(LAST_RUN, { ids, at: new Date().toISOString(), people: p.need.length, by: who && who.name }, who);
    await prisma.auditLog.createMany({ data: p.need.map((e) => ({ userId: who && who.id, actorName: who && who.name, action: 'Stationery default kit given', entity: 'StationeryIssue', entityId: BATCH, toValue: `${e.lines.map((l) => countOf(l.name, l.quantity)).join(' + ')} to ${e.person.name}${e.person.employeeCode ? ` (${e.person.employeeCode})` : ''}` })) }).catch(() => {});
  }
  return { people: p.need.length, rows: ids.length, what: p.what };
}

// Undo the LAST bulk run: remove exactly its rows, unless one was taken back since.
async function undoLast(who) {
  const last = await readRow(LAST_RUN);
  if (!last || !Array.isArray(last.ids) || !last.ids.length) throw Object.assign(new Error('There is no run to undo.'), { status: 404 });
  const rows = await prisma.stationeryIssue.findMany({ where: { id: { in: last.ids } } });
  const returned = rows.length
    ? await prisma.stationeryIssue.count({ where: { kind: 'RETURN', OR: rows.map((r) => ({ employeeId: r.employeeId, itemId: r.itemId, createdAt: { gte: r.createdAt } })) } })
    : 0;
  if (returned) throw Object.assign(new Error('Some of those kits were already taken back, so this run cannot be undone in one go.'), { status: 409 });
  const r = await prisma.stationeryIssue.deleteMany({ where: { id: { in: last.ids } } });
  await prisma.appSetting.delete({ where: { key: LAST_RUN } }).catch(() => {});
  await logAudit({ userId: who && who.id, actorName: who && who.name, action: 'Stationery default kit run undone', entity: 'StationeryIssue', entityId: BATCH, toValue: `${r.count} row(s) removed (run of ${last.at})` });
  return { removed: r.count, people: last.people };
}

// A person became Active / was created: give the kit once. Never throws.
async function onActive(employeeId, who = null) {
  try {
    if (!ready() || !employeeId) return null;
    const kit = await getKit();
    if (!kit.on) return null;
    const p = await prisma.employee.findFirst({ where: withoutSystemAccounts({ id: employeeId, employmentStatus: { in: ACTIVE } }), select: { id: true, employeeCode: true, name: true } });
    if (!p) return null;
    const lines = (await resolvedLines(kit)).filter((l) => l.item && l.item.active);
    const marked = await markedPairs([p.id]);
    const miss = lines.filter((l) => !marked.has(`${p.id}|${l.item.id}`));
    if (!miss.length) return { given: 0 };
    const ids = await giveTo([{ person: p, lines: miss }], who);
    if (ids.length) await logAudit({ userId: who && who.id, actorName: who && who.name, action: 'Stationery default kit given', entity: 'StationeryIssue', entityId: BATCH, toValue: `${miss.map((l) => countOf(l.name, l.quantity)).join(' + ')} to ${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''} (new employee)` }).catch(() => {});
    return { given: ids.length };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stationery-kit]', err && err.message);
    return null;
  }
}

// Everybody created since the kit was switched on (real people only).
async function sweep() {
  if (!ready()) return { given: 0 };
  const kit = await getKit();
  if (!kit.on) return { given: 0 };
  const since = new Date(kit.autoFrom || Date.now());
  const p = await missingPlan();
  const fresh = (await prisma.employee.findMany({ where: { id: { in: p.need.map((n) => n.person.id) }, createdAt: { gte: since } }, select: { id: true } })).map((e) => e.id);
  const todo = p.need.filter((n) => fresh.includes(n.person.id));
  const ids = await giveTo(todo, null);
  return { given: ids.length, people: todo.length };
}
let timer = null;
function startSweep() {
  if (timer || process.env.TEST_MODE === '1' || process.env.TL_SANDBOX) return;
  const run = () => sweep().catch((e) => console.error('[stationery-kit] sweep', e && e.message)); // eslint-disable-line no-console
  setTimeout(run, 60000);
  timer = setInterval(run, 10 * 60000);
}

module.exports = {
  KEY, LAST_RUN, BATCH, NOTE, ACTIVE, getKit, saveKit, resolvedLines, previewAll, applyAll, undoLast, onActive, sweep, startSweep, missingPlan, giveTo, markedPairs,
};
