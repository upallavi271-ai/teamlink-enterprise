// ---------------------------------------------------------------------------
// MY DASHBOARD LAYOUT (founder audit 2026-11-17: drag-and-drop dashboard
// widgets). Each login keeps its OWN order of the ATS dashboard cards and the
// cards it has hidden. Nothing about the numbers changes: the server still
// decides which cards a role gets (utils/atsHome.js); this only remembers how
// the person arranged them. A card the role no longer has is simply skipped;
// a new card shows up where the page puts it by default.
//
// Stored in a raw SQL table, self-provisioned (like utils/recycleBin.js):
//   DashboardLayout(userId, board, layout JSON { order: [id…], hidden: [id…] }, updatedAt)
// PUBLIC API
//   getLayout(userId, board)          -> { order, hidden, updatedAt } | null
//   saveLayout(userId, board, input)  -> the cleaned layout (throws 400 on a bad one)
//   resetLayout(userId, board)        -> true (the default layout again)
//   cleanLayout(input)                -> { order, hidden } (throws 400)
// ---------------------------------------------------------------------------
const prisma = require('../db');

const BOARDS = ['ats-home'];
const MAX_IDS = 120;
const ID_RE = /^[A-Za-z0-9:_.-]{1,80}$/;

let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DashboardLayout" ("userId" TEXT NOT NULL, "board" TEXT NOT NULL, "layout" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL, PRIMARY KEY ("userId", "board"))`)
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}

function bad(message) { const e = new Error(message); e.status = 400; return e; }
function checkBoard(board) { if (!BOARDS.includes(board)) throw bad('Unknown dashboard.'); }

function cleanLayout(input) {
  const v = input && typeof input === 'object' ? input : null;
  if (!v) throw bad('Send the layout as { order: [...], hidden: [...] }.');
  const list = (x, name) => {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x)) throw bad(`${name} must be a list.`);
    if (x.length > MAX_IDS) throw bad(`${name} has too many cards.`);
    const out = [];
    x.forEach((id) => {
      const s = String(id);
      if (!ID_RE.test(s)) throw bad(`"${s.slice(0, 40)}" is not a card name.`);
      if (!out.includes(s)) out.push(s);
    });
    return out;
  };
  return { order: list(v.order, 'order'), hidden: list(v.hidden, 'hidden') };
}

async function getLayout(userId, board = 'ats-home') {
  checkBoard(board);
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "layout", "updatedAt" FROM "DashboardLayout" WHERE "userId" = ? AND "board" = ?', String(userId), board);
  if (!rows || !rows[0]) return null;
  try {
    const l = cleanLayout(JSON.parse(rows[0].layout));
    return { ...l, updatedAt: rows[0].updatedAt };
  } catch { return null; }
}

async function saveLayout(userId, board, input) {
  checkBoard(board);
  const l = cleanLayout(input);
  await ensure();
  const at = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    'INSERT INTO "DashboardLayout" ("userId","board","layout","updatedAt") VALUES (?,?,?,?) ON CONFLICT("userId","board") DO UPDATE SET "layout" = excluded."layout", "updatedAt" = excluded."updatedAt"',
    String(userId), board, JSON.stringify(l), at,
  );
  return { ...l, updatedAt: at };
}

async function resetLayout(userId, board = 'ats-home') {
  checkBoard(board);
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "DashboardLayout" WHERE "userId" = ? AND "board" = ?', String(userId), board);
  return true;
}

module.exports = {
  getLayout, saveLayout, resetLayout, cleanLayout, BOARDS,
};
