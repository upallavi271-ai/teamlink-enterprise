// ---------------------------------------------------------------------------
// CANDIDATE SEARCH INDEX (self-provisioned, raw SQL like utils/recycleBin.js): a narrow, lower-cased copy of the few columns the search reads
// (name, skills, company / designation / location, e-mail, the phone as digits only), kept in step with the Candidate table by three triggers.
// Why: the search looks inside names, skills, e-mails and numbers ("%word%"), which no ordinary index can serve; scanning the wide Candidate rows
// of 100,000 people took over a second, scanning this narrow table takes a few tens of milliseconds. The scope of the login (candidateWhere) is NOT
// in here: the search takes the matching ids from this table and then asks Prisma for those few rows through the login's own scope.
//
//   ensure()                         creates the table + triggers once (and checks, every 5 minutes, that it is complete)
//   ids({ tokens, cols, digits, idLike, limit })   ids of candidates matching EVERY word (partial, any case), or the phone digits, or the id
//   fuzzyIds(tokens, limit)          ids whose NAME matches every word with one slip of a letter
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "CandidateSearch" ("id" TEXT NOT NULL PRIMARY KEY, "nameKey" TEXT NOT NULL DEFAULT '', "basic" TEXT NOT NULL DEFAULT '', "more" TEXT NOT NULL DEFAULT '', "contact" TEXT NOT NULL DEFAULT '', "phoneDigits" TEXT NOT NULL DEFAULT '')`,
];
const ROW = (r) => `lower(coalesce(${r}.name,'')), lower(coalesce(${r}.name,'')||' '||coalesce(${r}.skills,'')), lower(coalesce(${r}.currentCompany,'')||' '||coalesce(${r}.currentDesignation,'')||' '||coalesce(${r}.location,'')), lower(coalesce(${r}.email,'')), replace(replace(replace(replace(replace(coalesce(${r}.phone,''),' ',''),'-',''),'+',''),'(',''),')','')`;
const COLS = '"id","nameKey","basic","more","contact","phoneDigits"';
const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS "CandidateSearch_ai" AFTER INSERT ON "Candidate" BEGIN INSERT OR REPLACE INTO "CandidateSearch" (${COLS}) VALUES (NEW.id, ${ROW('NEW')}); END`,
  `CREATE TRIGGER IF NOT EXISTS "CandidateSearch_au" AFTER UPDATE OF name, email, phone, skills, currentCompany, currentDesignation, location ON "Candidate" BEGIN INSERT OR REPLACE INTO "CandidateSearch" (${COLS}) VALUES (NEW.id, ${ROW('NEW')}); END`,
  `CREATE TRIGGER IF NOT EXISTS "CandidateSearch_ad" AFTER DELETE ON "Candidate" BEGIN DELETE FROM "CandidateSearch" WHERE "id" = OLD.id; END`,
];
const BACKFILL = `INSERT OR REPLACE INTO "CandidateSearch" (${COLS}) SELECT c.id, ${ROW('c')} FROM "Candidate" c`;

let readyP = null;
let checkedAt = 0;
async function provision() {
  for (const s of DDL) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
  for (const s of TRIGGERS) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
  const [a] = await prisma.$queryRawUnsafe('SELECT (SELECT count(*) FROM "Candidate") AS c, (SELECT count(*) FROM "CandidateSearch") AS s');
  if (Number(a.c) !== Number(a.s)) {
    await prisma.$executeRawUnsafe('DELETE FROM "CandidateSearch" WHERE "id" NOT IN (SELECT id FROM "Candidate")');
    // in slices of 5,000 rows, so the writes of everybody else are never held up for long
    const [m] = await prisma.$queryRawUnsafe('SELECT coalesce(max(rowid), 0) AS m FROM "Candidate"');
    for (let from = 0; from <= Number(m.m); from += 5000) await prisma.$executeRawUnsafe(`${BACKFILL} WHERE c.rowid > ${from} AND c.rowid <= ${from + 5000}`); // eslint-disable-line no-await-in-loop
  }
  checkedAt = Date.now();
  return true;
}
function ensure() {
  if (!readyP) readyP = provision().catch((e) => { readyP = null; console.error('[candidateSearchIndex]', e.message); return false; }); // eslint-disable-line no-console
  else if (Date.now() - checkedAt > 300000) { checkedAt = Date.now(); readyP = readyP.then(() => provision()).catch(() => false); }
  return readyP;
}

const wordsOnly = (t) => t.replace(/[^\p{L}\p{N}]/gu, '');
// tokens: [{ t, alt }]; cols: the columns this login may search ('basic' | 'more' | 'contact')
async function ids({
  tokens = [], cols = ['basic'], digits = '', idLike = '', limit = 150,
}) {
  if (!(await ensure())) return null; // null = no index: the caller falls back
  const expr = cols.map((c) => `"${c}"`).join(` || ' ' || `);
  const args = [];
  const wordClauses = tokens.map((tok) => {
    const alts = [tok.t, ...(tok.alt && tok.alt.length >= 3 ? [tok.alt] : [])];
    alts.forEach((a) => args.push(`%${a.replace(/[%_]/g, '')}%`));
    return `(${alts.map(() => `(${expr}) LIKE ?`).join(' OR ')})`;
  });
  const arms = [];
  if (wordClauses.length) arms.push(`(${wordClauses.join(' AND ')})`);
  if (digits.length >= 5) { arms.push('"phoneDigits" LIKE ?'); args.push(`%${digits.slice(-10)}%`); }
  if (idLike) { arms.push('"id" = ?'); args.push(idLike); if (idLike.length <= 10) { arms.push('"id" LIKE ?'); args.push(`%${idLike}`); } }
  if (!arms.length) return [];
  const first = tokens.length ? (tokens[0].alt && tokens[0].alt.length >= 3 ? tokens[0].alt : tokens[0].t).replace(/[%_]/g, '') : '';
  const order = first ? ` ORDER BY ("nameKey" LIKE ?) DESC, ("nameKey" LIKE ?) DESC, "nameKey"` : '';
  if (first) { args.push(`${first}%`, `% ${first}%`); }
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT "id" FROM "CandidateSearch" WHERE ${arms.join(' OR ')}${order} LIMIT ${Math.min(2000, limit)}`, ...args);
    return rows.map((r) => r.id);
  } catch (e) { console.error('[candidateSearchIndex] ids:', e.message); return null; } // eslint-disable-line no-console
}

// ---- one slip of a letter (wrong, missing, extra, swapped) in a NAME --------------------------------------------------------------------------
// SQL narrows by the two halves of every word (a slip spoils at most one half), then the exact rule is checked here on the few survivors.
const within1 = (a, b) => {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one wrong letter
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two swapped
  }
  const [long, short] = la > lb ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i); // one missing / extra letter
};
const nameMatches = (nameKey, toks) => {
  const words = nameKey.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return toks.every((tok) => {
    const w = wordsOnly(tok.t);
    return nameKey.includes(w) || words.some((x) => within1(x, w)) || (tok.alt && tok.alt.length >= 4 && words.some((x) => within1(x, tok.alt)));
  });
};
async function fuzzyIds(tokens, limit = 60) {
  if (!(await ensure())) return null;
  const toks = tokens.filter((t) => wordsOnly(t.t).length >= 4 && !/\d/.test(t.t));
  if (!toks.length || toks.length < tokens.length) return []; // a number is never "nearly" a number
  const args = [];
  const parts = toks.map((tok) => {
    const chars = [...wordsOnly(tok.t)];
    const half = Math.ceil(chars.length / 2);
    const alts = [chars.slice(0, half).join(''), chars.slice(chars.length - half).join('')];
    if (tok.alt && tok.alt.length >= 4) { const ac = [...tok.alt]; const ah = Math.ceil(ac.length / 2); alts.push(ac.slice(0, ah).join(''), ac.slice(ac.length - ah).join('')); }
    alts.forEach((x) => args.push(`%${x}%`));
    return `(${alts.map(() => '"nameKey" LIKE ?').join(' OR ')})`;
  });
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT "id","nameKey" FROM "CandidateSearch" WHERE ${parts.join(' AND ')} LIMIT 4000`, ...args);
    return rows.filter((r) => nameMatches(r.nameKey, toks)).slice(0, limit).map((r) => r.id);
  } catch { return []; }
}

module.exports = { ensure, ids, fuzzyIds };
