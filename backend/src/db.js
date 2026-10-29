const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// SQLITE WRITE SETTINGS.
//
// Measured on this database, importing real data: 19.4ms per write with the
// defaults, 3.2ms with the two pragmas below. Six times faster, and the
// difference between a twenty-minute data import and a four-minute one — but
// it matters far more for ordinary use, because every one of those 19ms was a
// request waiting on the disk.
//
//   journal_mode=WAL    Writers stop blocking readers. In the default DELETE
//                       mode a single write locks the whole database, so one
//                       person saving a candidate stalls everybody else's
//                       screens. WAL is stored in the database file, so it is
//                       set once and stays set; it is repeated here so a fresh
//                       database gets it too.
//
//   synchronous=NORMAL  The default FULL fsyncs to disk on every single
//                       statement. NORMAL fsyncs at checkpoints instead.
//                       With WAL this is the configuration SQLite itself
//                       recommends: a crash of this application cannot corrupt
//                       or lose a committed transaction, and only a power cut
//                       or an OS crash could lose the last few. For a business
//                       app on one machine that is the right trade; an
//                       application that must survive a power cut mid-write
//                       would set FULL back and pay the 19ms.
//
// Applied per connection and on startup. Failures are logged, never thrown —
// a pragma that does not take is slow, not broken, and taking the whole API
// down over it would be a far worse outcome than the speed.
// ---------------------------------------------------------------------------
// Each pragma is applied on its own, because one failing must not skip the
// rest — and `PRAGMA journal_mode` RETURNS THE NEW MODE, which means it has to
// go through $queryRaw. Sending it through $executeRaw fails with "Execute
// returned results, which is not allowed in SQLite", and when all three shared
// one try block that error silently cost us synchronous=NORMAL as well.
(async () => {
  const pragma = async (sql, returnsRows) => {
    try {
      if (returnsRows) await prisma.$queryRawUnsafe(sql);
      else await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error(`[db] pragma failed (${sql}) —`, err.message.split('\n')[0]);
    }
  };
  await pragma('PRAGMA journal_mode=WAL', true);
  await pragma('PRAGMA synchronous=NORMAL', false);
  // Wait rather than fail when another connection holds the write lock.
  // busy_timeout also reports the value it set, so it reads like a query too.
  await pragma('PRAGMA busy_timeout=5000', true);
})();

// dup_: every way a candidate comes in or changes gets its duplicate check (utils/candidateDupHook.js).
// Never throws; answers nothing when the duplicate tables are not there.
prisma.$use(async (params, next) => {
  const result = await next(params);
  if (params.model === 'Candidate' || params.model === 'CandidateResume' || params.model === 'CandidateDocument') {
    try { await require('./utils/candidateDupHook').after(params, result); } catch (err) { console.error('[dup] hook:', err.message); } // eslint-disable-line global-require
  }
  return result;
});

// jobdup_: every way a job is created or changed keeps the duplicate-jobs worklist fresh (utils/jobDupHook.js).
// Only marks a cache stale; never throws, writes nothing.
prisma.$use(async (params, next) => {
  const result = await next(params);
  if (params.model === 'Requirement' || params.model === 'RequirementPosting') {
    try { require('./utils/jobDupHook').after(params); } catch { /* the worklist refreshes on its own */ } // eslint-disable-line global-require
  }
  return result;
});

// vendorlink_: a bill booked in Accounts is linked to its vendor by the vendor's id the moment it is saved (utils/vendorExpenseLink.js).
// Only fills vendorId when the vendor text matches exactly one vendor master record; never throws.
prisma.$use(async (params, next) => {
  if (params.model === 'OfficeExpense' && (params.action === 'create' || params.action === 'update')) {
    try { await require('./utils/vendorExpenseLink').before(prisma, params); } catch (err) { console.error('[vendorlink] hook:', err.message); } // eslint-disable-line global-require
  }
  return next(params);
});

// owner_: an application created without a recruiter (portal, job board, careers page, import ...) goes to the requirement's own
// recruiter (utils/applicationOwner.js, founder 2026-10-26). Never throws.
prisma.$use(async (params, next) => {
  if (params.model === 'Application' && params.action === 'create') {
    try { await require('./utils/applicationOwner').before(prisma, params); } catch (err) { console.error('[owner] hook:', err.message); } // eslint-disable-line global-require
  }
  return next(params);
});

// seat_: a Naukri / Shine mailbox follows its HRMS position at once (founder 2026-10-29: "aa recruiter position kii avaraina ostey
// automatic gaa aa recruiter kii assign ayii povali"): any write to a seat, a seat tenure or a person's status / joining / email
// asks utils/mailboxSeats.js to move the mailboxes to the new holder (debounced, in the background). Never throws, never waits.
prisma.$use(async (params, next) => {
  const result = await next(params);
  if (/^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(params.action)) {
    try { require('./utils/mailboxSeats').afterWrite(params); } catch { /* the hourly run catches up */ } // eslint-disable-line global-require
  }
  return result;
});

module.exports = prisma;
