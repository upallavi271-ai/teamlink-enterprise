const prisma = require('../db');

// ---------------------------------------------------------------------------
// AUTOMATIC NUMBERS — Agreement No. (AGR0001) and Client ID (CLI0001).
//
// One counter per kind, kept in the AppSetting table (key "autoNumber:AGR").
// Taking a number is ONE SQL statement (insert-or-add-one, RETURNING the
// value), so two people saving at the same second can never get the same
// number, and a number that was taken is never handed out again — even when
// the client that held it was merged or its agreement was cleared.
//
// A new counter starts after the highest number already on file, so numbers
// that were typed or imported by hand are never clashed with. If the counter
// ever lands on a number that is already used (a hand-typed or imported one),
// it simply moves on to the next.
// ---------------------------------------------------------------------------

const KINDS = {
  AGR: { prefix: 'AGR', field: 'agreementId', digits: 4 },
  CLI: { prefix: 'CLI', field: 'clientCode', digits: 4 },
};

const format = (kind, n) => `${KINDS[kind].prefix}${String(n).padStart(KINDS[kind].digits, '0')}`;

// The highest AGR/CLI number already stored (case-insensitive: "cl0001" and
// "Cl0001" are other spellings of a Client ID, so they hold their number too).
async function highestOnFile(kind, db = prisma) {
  const { prefix, field } = KINDS[kind];
  const rows = await db.client.findMany({ where: { [field]: { not: null } }, select: { [field]: true } });
  const re = new RegExp(`^${prefix}0*(\\d+)$`, 'i');
  let max = 0;
  rows.forEach((r) => {
    const m = String(r[field] || '').trim().match(re);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max;
}

async function takeCounter(kind, db = prisma) {
  const key = `autoNumber:${kind}`;
  const seed = (await highestOnFile(kind, db)) + 1; // used only if the counter does not exist yet
  const rows = await db.$queryRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${String(seed)}, ${new Date()})
    ON CONFLICT("key") DO UPDATE SET "value" = CAST("value" AS INTEGER) + 1, "updatedAt" = ${new Date()}
    RETURNING "value"`;
  return Number(rows[0].value);
}

// The next free number for a kind, e.g. next('AGR') -> "AGR0004".
async function next(kind, db = prisma) {
  const { field } = KINDS[kind];
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const n = await takeCounter(kind, db);
    const code = format(kind, n);
    // eslint-disable-next-line no-await-in-loop
    const clash = await db.client.findFirst({ where: { [field]: { equals: code } }, select: { id: true } });
    if (!clash) return code;
  }
  throw new Error(`Could not find a free ${kind} number`);
}

// Move the counter up so the next number is at least `n` (used by the
// numbering script after it hands out a batch).
async function ensureCounterAtLeast(kind, lastUsed, db = prisma) {
  const key = `autoNumber:${kind}`;
  const row = await db.appSetting.findUnique({ where: { key } });
  const current = row ? Number(row.value) : 0; // the counter holds the LAST number handed out
  if (!row) {
    await db.appSetting.create({ data: { key, value: String(lastUsed) } });
  } else if (current < lastUsed) {
    await db.appSetting.update({ where: { key }, data: { value: String(lastUsed) } });
  }
}

module.exports = {
  KINDS, format, highestOnFile, next, ensureCounterAtLeast,
  nextAgreementNumber: () => next('AGR'),
  nextClientNumber: () => next('CLI'),
};
