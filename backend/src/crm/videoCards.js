// ---------------------------------------------------------------------------
// OUR PRODUCTS > VIDEOS (founder 2026-11-17: "kothaga, em upload chesina, cards kindha add ipovali" - every video uploaded shows as a card under
// the product cards). One card per video, newest first:
//   full      an all-products upload, played whole (its original)            - on demo pages OFF by default when longer than 5 minutes
//   company   the company / general video                                    - ON by default (top of the demo page)
//   extra     "+ Add another video" for a product                            - ON when 5 minutes or shorter (under that product)
//   original  a product's own upload, whole (its clip is the product's demo) - OFF by default (the clip already shows)
// A card appears when its upload is done (crm/productVideo.js calls addForJob). The cards are what the demo pages and the AI meeting show;
// the product cards and their clips are separate and unchanged, and a card is never a product (no leads, quotes, funnel or meeting list).
// Removing a card deletes its file only when nothing else uses it (another card, a product's clip, an upload still being worked on).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const prisma = require('../db');
const S = require('./service');
const PS = require('./productSales');

const KINDS = ['full', 'company', 'extra', 'original'];
const LONG = 300; // seconds: "short" up to 5 minutes
const nowIso = () => new Date().toISOString();
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));
const dir = () => PS.VIDEO_DIR();
// a card's file is kept relative to the demo folder: "sources/vid_x.mp4" for an original, "HRMS-X1234.mp4" for a cut clip
const fileOf = (c) => (c && c.file ? path.join(dir(), c.file.split('/').map((x) => path.basename(x)).join(path.sep)) : null);
const defaultShow = (kind, duration) => (kind === 'company' ? true : kind === 'original' ? false : !(Number(duration) > LONG));

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await PS.ensure();
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CrmVideoCard" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "productKey" TEXT, "title" TEXT, "file" TEXT NOT NULL,
        "duration" REAL, "jobId" TEXT, "uploadedById" TEXT, "uploadedByName" TEXT, "uploadedAt" TEXT, "showOnDemo" INTEGER NOT NULL DEFAULT 1, "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "CrmVideoCard_file" ON "CrmVideoCard" ("file")');
      await backfill().catch(() => {});
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
async function add({ kind, productKey = null, title, file, duration = null, job = null, showOnDemo = null }) {
  if (!KINDS.includes(kind) || !file) return null;
  const [have] = await prisma.$queryRawUnsafe('SELECT "id" FROM "CrmVideoCard" WHERE "file" = ?', file);
  if (have) return have.id;
  if (!fs.existsSync(fileOf({ file }))) return null;
  if (duration == null) duration = await require('./productVideo').durationOf(fileOf({ file })).catch(() => null); // eslint-disable-line global-require
  const id = S.newId('vcard');
  const now = nowIso();
  await prisma.$executeRawUnsafe('INSERT INTO "CrmVideoCard" ("id","kind","productKey","title","file","duration","jobId","uploadedById","uploadedByName","uploadedAt","showOnDemo","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, kind, productKey, String(title || 'Video').slice(0, 160), file, duration, job ? job.id : null, job ? job.createdById : null, job ? job.createdByName : null, job ? job.createdAt : now,
    (showOnDemo == null ? defaultShow(kind, duration) : showOnDemo) ? 1 : 0, now, now);
  return id;
}
const plainTitle = (job) => (job.title || String(job.fileName || 'Video').replace(/\.[a-z0-9]+$/i, '')).slice(0, 160);
// the cards an upload makes when it is done (clip = the file just cut for an extra / company video)
async function addForJob(job, opts = {}) {
  await ensure();
  return cardsForJob(job, opts);
}
// (the set-up below calls this one directly: waiting for ensure() from inside it would wait for itself)
async function cardsForJob(job, { clip = null } = {}) {
  const source = `sources/${job.id}${path.extname(job.fileName || '.mp4').toLowerCase() || '.mp4'}`;
  if (job.kind === 'all') return add({ kind: 'full', title: plainTitle(job), file: source, duration: job.duration, job });
  if (job.kind === 'single') return add({ kind: 'original', productKey: job.productKey, title: plainTitle(job), file: source, duration: job.duration, job });
  if (job.kind === 'extra' && clip) return add({ kind: 'extra', productKey: job.productKey, title: plainTitle(job), file: clip, job });
  if (job.kind === 'company' && clip) return add({ kind: 'company', title: job.title || 'About TeamLink', file: clip, job });
  return null;
}
// once: today's uploads, the company video and the products' other videos become cards
async function backfill() {
  const PD = require('./productDeals'); // eslint-disable-line global-require
  const st = await PD.settings();
  if (st.cardsFilled) return;
  const jobs = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoJob" WHERE "status" = \'done\' AND "kind" IN (\'all\',\'single\') ORDER BY "createdAt"').catch(() => []);
  for (const j of jobs) await cardsForJob(j).catch(() => null); // eslint-disable-line no-await-in-loop
  if (st.companyVideoFile) await add({ kind: 'company', title: st.companyVideoTitle || 'About TeamLink', file: path.basename(st.companyVideoFile) }).catch(() => null);
  for (const p of await PS.products({ all: true })) {
    for (const x of p.extraVideos || []) await add({ kind: 'extra', productKey: p.key, title: x.title, file: path.basename(x.file) }).catch(() => null); // eslint-disable-line no-await-in-loop
  }
  await PD.markCardsFilled();
}

// ---- reading ------------------------------------------------------------------------------------------------------------------
const shape = (c, names = {}) => ({ ...c, showOnDemo: !!c.showOnDemo, belongsTo: c.kind === 'full' ? 'All products' : c.kind === 'company' ? 'Company' : (names[c.productKey] || c.productKey), available: fs.existsSync(fileOf(c)) });
async function all() {
  await ensure();
  return prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" ORDER BY COALESCE("uploadedAt", "createdAt") DESC');
}
async function list(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const names = Object.fromEntries((await PS.products({ all: true })).map((p) => [p.key, p.name]));
  return S.okBody({ cards: (await all()).map((c) => shape(c, names)) });
}
// what a demo page / meeting room may show: the cards turned on, for those products (company and full ones for every lead)
async function forDemo(keys) {
  return (await all()).filter((c) => c.showOnDemo && fs.existsSync(fileOf(c)) && (c.kind === 'company' || c.kind === 'full' || (keys || []).includes(c.productKey)));
}
async function fileForDemo(id, keys) {
  const c = (await forDemo(keys)).find((x) => x.id === id);
  return c ? fileOf(c) : null;
}
async function fileForStaff(id) {
  await ensure();
  const [c] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "id" = ?', String(id));
  const f = c && fileOf(c);
  return f && fs.existsSync(f) ? f : null;
}
async function watch(user, id) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  await ensure();
  const [c] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "id" = ?', String(id));
  if (!c || !fs.existsSync(fileOf(c))) return S.fail(404, 'This video is not on the server any more.');
  return S.okBody({ ok: true, url: `/api/crm-public/product-video/${PS.makeToken('pv', user.id, ['CARD'], 0.25, c.id)}`, name: c.title });
}
// files a card uses (the upload clean-up and removals keep them)
async function filesInUse() {
  return new Set((await all()).map((c) => c.file));
}

// ---- managers change a card ------------------------------------------------------------------------------------------------------
async function update(user, id, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can change the videos.');
  await ensure();
  const [c] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "id" = ?', String(id));
  if (!c) return S.fail(404, 'No such video.');
  const title = body.title == null ? c.title : String(body.title).trim().slice(0, 160);
  if (!title) return S.fail(400, 'Give the video a title.');
  const show = body.showOnDemo == null ? c.showOnDemo : (body.showOnDemo ? 1 : 0);
  await prisma.$executeRawUnsafe('UPDATE "CrmVideoCard" SET "title" = ?, "showOnDemo" = ?, "updatedAt" = ? WHERE "id" = ?', title, show, nowIso(), c.id);
  if (body.showOnDemo != null && !!body.showOnDemo !== !!c.showOnDemo) await S.audit(user, body.showOnDemo ? 'CRM video shown on demo pages' : 'CRM video taken off demo pages', 'CrmVideoCard', c.id, title);
  const [n] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "id" = ?', c.id);
  return S.okBody({ ok: true, card: shape(n) });
}
async function remove(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can remove videos.');
  await ensure();
  const [c] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "id" = ?', String(id));
  if (!c) return S.fail(404, 'No such video.');
  await prisma.$executeRawUnsafe('DELETE FROM "CrmVideoCard" WHERE "id" = ?', c.id);
  // the file goes only when nothing else uses it: a product's demo clip, another card, an upload still being worked on
  const clips = (await PS.products({ all: true })).map((p) => p.videoFile).filter(Boolean);
  const busy = await prisma.$queryRawUnsafe('SELECT "id", "fileName" FROM "CrmVideoJob" WHERE "status" IN (\'uploading\',\'queued\',\'analysing\',\'cutting\',\'draft\')').catch(() => []);
  const busyFiles = busy.map((j) => `sources/${j.id}${path.extname(j.fileName || '.mp4').toLowerCase() || '.mp4'}`);
  let kept = 'kept';
  if (!clips.includes(path.basename(c.file)) && !(await filesInUse()).has(c.file) && !busyFiles.includes(c.file)) {
    try { fs.unlinkSync(fileOf(c)); kept = 'deleted'; } catch { kept = 'gone'; }
  }
  await S.audit(user, 'CRM video removed', 'CrmVideoCard', c.id, `${c.title} (file ${kept})`);
  return S.okBody({ ok: true, file: kept });
}
// the cards of an upload (its original): for the uploads list ("✕ asks first") and removing the upload with its cards
async function cardsOfSource(source) {
  await ensure();
  return prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoCard" WHERE "file" = ?', source);
}
async function removeBySource(source) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "CrmVideoCard" WHERE "file" = ?', source);
}

module.exports = { ensure, KINDS, LONG, add, addForJob, list, all, forDemo, fileForDemo, fileForStaff, watch, update, remove, filesInUse, cardsOfSource, removeBySource, fileOf, defaultShow };
