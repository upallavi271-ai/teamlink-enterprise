// ---------------------------------------------------------------------------
// PARSING QUALITY (founder audit 2026-11-18, checklist-168 #55, audit 83, practical P6.1): how right the resume parser is, measured and kept.
// A run = scripts/resume-parse-accuracy.js run(): the built-in sample resumes with known answers, plus every resume found under the folder in
// RESUME_SAMPLE_DIR (with an optional "<file>.expected.json" next to each). Every run is stored (table ParseQualityRun) so a change in accuracy
// shows over time. Admin -> Candidates -> Verify -> "Parsing quality".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ParseQualityRun" ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL, "byName" TEXT, "samples" INTEGER, "files" INTEGER,
        "overall" REAL, "perField" TEXT, "folder" TEXT, "note" TEXT)`);
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

async function runAndStore(user, { sampleDir = process.env.RESUME_SAMPLE_DIR || null } = {}) {
  await ensure();
  const acc = require(path.resolve(__dirname, '..', '..', 'scripts', 'resume-parse-accuracy.js')); // eslint-disable-line global-require
  const r = await acc.run({ quiet: true, sampleDir });
  const perField = Object.fromEntries(acc.FIELDS.map((f) => [f, { accuracy: r.accuracy[f], checked: r.checked[f] }]));
  const folder = r.folder ? {
    dir: path.basename(r.folder.dir), files: r.folder.files, readable: r.folder.readable, withExpected: r.folder.withExpected, accuracy: r.folder.accuracy, coverage: r.folder.coverage, unreadable: r.folder.unreadable.slice(0, 20),
  } : null;
  const id = crypto.randomUUID();
  const note = sampleDir ? null : 'RESUME_SAMPLE_DIR is not set, so only the built-in sample resumes were measured.';
  await prisma.$executeRawUnsafe('INSERT INTO "ParseQualityRun" ("id","at","byName","samples","files","overall","perField","folder","note") VALUES (?,?,?,?,?,?,?,?,?)',
    id, new Date().toISOString(), user ? user.name : null, r.samples, r.folder ? r.folder.files : 0, r.overall, JSON.stringify(perField), folder ? JSON.stringify(folder) : null, note);
  return { id, samples: r.samples, files: r.folder ? r.folder.files : 0, overall: r.overall, perField, folder, note, skillsPrecision: r.skillsPrecision, skillsRecall: r.skillsRecall };
}
async function list(limit = 30) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "ParseQualityRun" ORDER BY "at" DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id, at: r.at, byName: r.byName, samples: r.samples, files: r.files, overall: r.overall, perField: json(r.perField, {}), folder: json(r.folder, null), note: r.note,
  }));
}
module.exports = { ensure, runAndStore, list };
