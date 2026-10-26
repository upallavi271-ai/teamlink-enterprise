#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// THE REAL SIGNED AGREEMENTS ON THE LIVE SITE TOO (founder 2026-10-26: "the signed agreements I gave must be on the server as they are").
//
// The signed agreement PDFs / pictures imported on 2026-10-17 live on THIS PC: one ClientDocument row (kind AGREEMENT_SIGNED) per file,
// its extras in AppSetting 'agrsigned.<id>', and the file itself in UPLOAD_DIR. The live site has its own database and its own UPLOAD_DIR,
// so they are carried over as a BUNDLE: the files (unchanged, byte for byte) + one manifest.json.
//
//   node scripts/signed-agreements-bundle.js export --out <dir>                  (on this PC) writes <dir>/manifest.json + <dir>/files/*
//   node scripts/signed-agreements-bundle.js import --bundle <dir>               (on the VPS) DRY RUN: what would be added, per client
//   TL_ALLOW_REAL_APPLY=1 node scripts/signed-agreements-bundle.js import --bundle <dir> --apply --really-real
//   node scripts/signed-agreements-bundle.js undo --manifest <undo.json> --really-real   takes the rows it added off again (files stay)
//   --db <dev.db>   another database (a copy)
//
// IMPORT finds the client on the live database by the SAME id, else by the same name (case / spacing / Pvt-Ltd ignored, one match only).
// A file the client already has (same stored name or same sha256) is not added twice. A client that cannot be found is listed, never guessed.
// It adds rows + files only: it does not change any client's agreement step (Signed / Active), so nothing else on the live site moves.
// SAFETY: dry run by default; VACUUM INTO backup before writing; one transaction; undo manifest; running it twice adds nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const MODE = argv[0];
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const KIND = 'AGREEMENT_SIGNED';
const PREFIX = 'agrsigned.';
const STORED = /^[a-f0-9]{32}\.(png|jpg|webp|pdf|docx|doc)$/;

if (!['export', 'import', 'undo'].includes(MODE)) { console.error('First word: export | import | undo  (see the top of this file)'); process.exit(2); }
if ((MODE === 'import' && APPLY) || MODE === 'undo') {
  if (isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
    console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first.');
    process.exit(2);
  }
}
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const attachments = require('../src/utils/attachments');
const { fullKey } = require('../src/utils/clientDedupe');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const uploadDir = () => {
  const dir = process.env.UPLOAD_DIR || path.join(os.homedir() || os.tmpdir(), '.teamlink-uploads');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
};

async function doExport() {
  const out = path.resolve(val('--out', path.join(os.tmpdir(), `signed-agreements-bundle-${STAMP}`)));
  fs.mkdirSync(path.join(out, 'files'), { recursive: true });
  const docs = await prisma.clientDocument.findMany({ where: { kind: KIND }, include: { client: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  const extras = await prisma.appSetting.findMany({ where: { key: { in: docs.map((d) => `${PREFIX}${d.id}`) } } });
  const extraOf = new Map(extras.map((e) => [e.key.slice(PREFIX.length), e.value]));
  const items = []; const missing = [];
  let bytes = 0;
  for (const d of docs) {
    const file = attachments.resolveStored(d.fileStored);
    if (!file) { missing.push(`${d.client ? d.client.name : d.clientId}: ${d.fileName || d.fileStored}`); continue; }
    fs.copyFileSync(file, path.join(out, 'files', d.fileStored));
    bytes += fs.statSync(file).size;
    items.push({
      id: d.id, clientId: d.clientId, clientName: d.client ? d.client.name : null, kind: d.kind, name: d.name, fileStored: d.fileStored,
      fileName: d.fileName, fileMime: d.fileMime, fileSize: d.fileSize, sha256: sha(file), uploadedByName: d.uploadedByName || 'Imported',
      createdAt: d.createdAt, extra: extraOf.get(d.id) || null,
    });
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), from: os.hostname(), count: items.length, items }, null, 1));
  console.log(`Bundle: ${out}\n  ${items.length} file(s), ${(bytes / 1048576).toFixed(1)} MB, for ${new Set(items.map((i) => i.clientId)).size} client(s)`);
  if (missing.length) console.log(`  ${missing.length} row(s) had no file on this PC and were left out:\n   ${missing.slice(0, 20).join('\n   ')}`);
}

async function doImport() {
  const bundle = path.resolve(val('--bundle', '.'));
  const man = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const byId = new Map(clients.map((c) => [c.id, c]));
  const byKey = new Map();
  clients.forEach((c) => { const k = fullKey(c.name); byKey.set(k, byKey.has(k) ? null : c); }); // null = two clients share the name: never guess
  const existing = await prisma.clientDocument.findMany({ where: { kind: KIND }, select: { id: true, clientId: true, fileStored: true } });
  const haveStored = new Set(existing.map((e) => `${e.clientId}|${e.fileStored}`));
  const haveIds = new Set(existing.map((e) => e.id));
  const dir = uploadDir();
  const haveSha = new Map(); // clientId -> Set(sha) of files already on the live site
  for (const e of existing) {
    const f = attachments.resolveStored(e.fileStored);
    if (!f) continue;
    if (!haveSha.has(e.clientId)) haveSha.set(e.clientId, new Set());
    haveSha.get(e.clientId).add(sha(f));
  }
  const plan = []; const notFound = []; let already = 0; let badFile = 0;
  for (const it of man.items) {
    const c = byId.get(it.clientId) || byKey.get(fullKey(it.clientName)) || null;
    if (!c) { notFound.push(it.clientName); continue; }
    if (haveStored.has(`${c.id}|${it.fileStored}`) || (haveSha.get(c.id) && haveSha.get(c.id).has(it.sha256))) { already += 1; continue; }
    const src = path.join(bundle, 'files', it.fileStored);
    if (!STORED.test(it.fileStored) || !fs.existsSync(src) || sha(src) !== it.sha256) { badFile += 1; continue; }
    plan.push({ it, client: c, by: byId.get(it.clientId) ? 'same id' : 'same name' });
  }
  const perClient = new Map();
  plan.forEach((p) => perClient.set(p.client.name, (perClient.get(p.client.name) || 0) + 1));
  console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}\nUPLOAD_DIR: ${dir}\nBundle: ${man.count} file(s) made ${man.at}\n`);
  console.log(`To add: ${plan.length} file(s) for ${perClient.size} client(s)  (${plan.filter((p) => p.by === 'same name').length} matched by name)\nAlready on the site: ${already}\nClient not found (listed, not guessed): ${notFound.length}${badFile ? `\nFile missing / damaged in the bundle: ${badFile}` : ''}`);
  [...perClient.entries()].slice(0, 25).forEach(([n, k]) => console.log(`   ${n}: ${k}`));
  if (perClient.size > 25) console.log(`   ... and ${perClient.size - 25} more`);
  if (notFound.length) console.log(`Not found:\n   ${[...new Set(notFound)].slice(0, 30).join('\n   ')}`);
  if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
  if (!plan.length) { console.log('\nNothing to add.'); return; }

  const outDir = path.join(isReal ? path.join(os.homedir(), '.teamlink-backups') : os.tmpdir(), `signed-agreements-import-${STAMP}`);
  fs.mkdirSync(outDir, { recursive: true });
  const bak = path.join(outDir, 'before.db');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
  const copied = [];
  for (const p of plan) {
    const dest = path.join(dir, p.it.fileStored);
    if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(bundle, 'files', p.it.fileStored), dest); copied.push(p.it.fileStored); }
  }
  const added = [];
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const it = p.it;
      // eslint-disable-next-line no-await-in-loop
      const row = await tx.clientDocument.create({
        data: {
          ...(haveIds.has(it.id) ? {} : { id: it.id }), clientId: p.client.id, kind: KIND, name: it.name, fileStored: it.fileStored,
          fileName: it.fileName, fileMime: it.fileMime, fileSize: it.fileSize, uploadedByName: it.uploadedByName || 'Imported', pending: false,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      if (it.extra) await tx.appSetting.upsert({ where: { key: `${PREFIX}${row.id}` }, create: { key: `${PREFIX}${row.id}`, value: it.extra }, update: { value: it.extra } });
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.create({ data: { action: 'Signed agreement file added from the bundle', entity: 'Client', entityId: p.client.id, toValue: it.fileName || it.fileStored, actorName: 'Signed agreements bundle 2026-10-26' } });
      added.push(row.id);
    }
  }, { timeout: 600000 });
  const undo = path.join(outDir, 'undo.json');
  fs.writeFileSync(undo, JSON.stringify({ at: new Date().toISOString(), db: dbArg, added, copied }, null, 1));
  console.log(`\nDONE: ${added.length} file(s) added (${copied.length} copied into UPLOAD_DIR).\nBackup: ${bak}\nUndo:   node scripts/signed-agreements-bundle.js undo --manifest "${undo}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
}

async function doUndo() {
  const m = JSON.parse(fs.readFileSync(path.resolve(val('--manifest')), 'utf8'));
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.deleteMany({ where: { key: { in: m.added.map((id) => `${PREFIX}${id}`) } } });
    await tx.clientDocument.deleteMany({ where: { id: { in: m.added } } });
  });
  console.log(`Undone: ${m.added.length} row(s) taken off (the files stay in UPLOAD_DIR).`);
}

(async () => {
  try {
    if (MODE === 'export') await doExport();
    else if (MODE === 'import') await doImport();
    else await doUndo();
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 800)); process.exit(1); });
