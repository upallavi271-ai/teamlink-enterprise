#!/usr/bin/env node
/**
 * OUR PRODUCTS: UPLOAD A VIDEO, THE CONTENT IS MADE FROM IT (founder 2026-11-17). A 64-second test video is made with ffmpeg (coloured parts
 * with a tone), its "narration" is a fixed transcript (CRM_STT_FAKE_JSON: the sandbox has no speech-to-text), then: upload in pieces,
 * the split per product, the draft text from each product's narration, Save -> the clips are cut part by part and joined, the text goes live;
 * a product's own video; who may do it; wrong times refused.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4078. Needs ffmpeg (FFMPEG_BIN, or imageio-ffmpeg's).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-product-video-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-prodvid-${process.pid}.db`);
const VID = path.join(os.tmpdir(), `zz-prodvid-dir-${process.pid}`);
let FF = process.env.FFMPEG_BIN;
if (!FF) { const r = spawnSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }); FF = (r.stdout || '').trim() || 'ffmpeg'; }
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
fs.mkdirSync(VID, { recursive: true });

// the test video: intro 0-5 blue, HRMS 5-25 red, ATS 25-40 green, Omni 40-58 yellow, closing 58-64 blue; a tone all through
const MOVIE = path.join(VID, 'all-products.mp4');
const parts = [['blue', 5], ['red', 20], ['green', 15], ['yellow', 18], ['blue', 6]];
const inputs = parts.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=30:d=${d}`]);
const mk = spawnSync(FF, ['-v', 'error', '-y', ...inputs, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=64',
  '-filter_complex', `${parts.map((_, i) => `[${i}:v]`).join('')}concat=n=${parts.length}:v=1:a=0[v]`, '-map', '[v]', '-map', `${parts.length}:a`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', MOVIE], { encoding: 'utf8' });
if (mk.status !== 0) { console.error('could not make the test video', mk.stderr); process.exit(1); }
const SINGLE = path.join(VID, 'omni-own.mp4');
spawnSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=purple:s=320x180:r=30:d=12', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SINGLE]);
const FAKE = path.join(VID, 'transcript.json');
fs.writeFileSync(FAKE, JSON.stringify([
  { s: 0.3, e: 4.6, t: 'This is Team Link Enterprise, module by module.' },
  { s: 5.2, e: 10.0, t: 'In HRMS, the HRMS dashboard shows headcount and attendance for the day.' },
  { s: 10.0, e: 16.0, t: 'Leave and holiday starts with pending requests and leave balances.' },
  { s: 16.0, e: 24.6, t: 'Payroll runs salaries with payslips, PF and ESI for every employee.' },
  { s: 25.2, e: 31.0, t: 'In the 80s, the dashboard shows clients waiting and requirements that need attention.' },
  { s: 31.0, e: 39.5, t: 'Candidates and pipeline show every application from recruiter check to joining.' },
  { s: 40.2, e: 46.0, t: 'A me channel opens on its dashboard with messages sent, delivered and read.' },
  { s: 46.0, e: 52.0, t: 'The WhatsApp inbox holds every chat and campaigns send to many people at once.' },
  { s: 52.0, e: 57.6, t: 'In admin, Wallet and Billing shows the balance and what each send costs.' },
  { s: 58.3, e: 63.5, t: 'Every module, every tab, one login.' },
]));

const PORT = 4078;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'prodvid-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, CRM_DEMO_DIR: VID, FFMPEG_BIN: FF, CRM_STT_FAKE_JSON: FAKE, PUBLIC_BASE_URL: `http://localhost:${PORT}` };
delete env.TEST_ALLOW_AI;
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token, headers = {}) => {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(API + url, { method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const durationOf = (f) => { const r = spawnSync(FF, ['-hide_banner', '-i', f], { encoding: 'utf8' }); const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || ''); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(VID, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
async function until(token, id, statuses, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('GET', `/crm/product-videos/${id}`, null, token); // eslint-disable-line no-await-in-loop
    if (r.body && r.body.job && statuses.includes(r.body.job.status)) return r.body.job;
    if (Date.now() - t0 > ms) return r.body && r.body.job;
    await wait(700); // eslint-disable-line no-await-in-loop
  }
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const plain = await prisma.user.create({ data: { name: `Pv plain ${process.pid}`, email: `pv.plain.${process.pid}@pv-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    await wait(500); // eslint-disable-line no-await-in-loop
  }
  await wait(1100);
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tP = await tok(plain.id);
  const before = await call('GET', '/crm/products?all=1', null, tA);
  const hrmsBefore = before.body.products.find((p) => p.key === 'HRMS');

  // ---- upload in pieces
  const file = fs.readFileSync(MOVIE);
  check('1 someone who is not a Sales manager / Admin cannot upload', (await call('POST', '/crm/product-videos', { kind: 'all', name: 'x.mp4', size: file.length }, tP)).status === 403);
  check('2 a file that is not a video is refused', (await call('POST', '/crm/product-videos', { kind: 'all', name: 'notes.pdf', size: 100 }, tA)).status === 400);
  const st = await call('POST', '/crm/product-videos', { kind: 'all', name: 'all-products.mp4', size: file.length }, tA);
  const id = st.body.id;
  check('3 the upload opens with 8 MB pieces', st.status === 200 && !!id && st.body.chunkSize === 8 * 1024 * 1024, st.body);
  const third = Math.ceil(file.length / 3);
  const p1 = await call('PUT', `/crm/product-videos/${id}/chunk?offset=0`, file.subarray(0, third), tA);
  const wrong = await call('PUT', `/crm/product-videos/${id}/chunk?offset=0`, file.subarray(0, third), tA);
  check('4 pieces arrive in order; a piece sent again says where the server is', p1.status === 200 && p1.body.received === third && wrong.status === 409 && wrong.body.received === third, { p1: p1.body, wrong: wrong.body });
  const early = await call('POST', `/crm/product-videos/${id}/finish`, null, tA);
  check('5 finishing before all pieces arrived is refused', early.status === 400, early.body);
  await call('PUT', `/crm/product-videos/${id}/chunk?offset=${third}`, file.subarray(third, 2 * third), tA);
  await call('PUT', `/crm/product-videos/${id}/chunk?offset=${2 * third}`, file.subarray(2 * third), tA);
  const fin = await call('POST', `/crm/product-videos/${id}/finish`, null, tA);
  check('6 all pieces in: the video is queued to be read', fin.status === 200 && ['queued', 'analysing', 'draft'].includes(fin.body.job.status), fin.body);

  // ---- the draft
  const job = await until(tA, id, ['draft', 'failed']);
  const d = job && job.draft;
  check('7 the video is read: draft ready, 64 seconds long', job && job.status === 'draft' && Math.abs(job.duration - 64) < 1, job && { s: job.status, e: job.error, dur: job.duration });
  const near = (a, b) => Math.abs(a - b) <= 1;
  check('8 the intro and the closing are found', d && d.intro && near(d.intro[0], 0) && near(d.intro[1], 4.9) && d.outro && near(d.outro[0], 57.9) && near(d.outro[1], 64), d && { i: d.intro, o: d.outro });
  check('9 the parts per product: HRMS 5-25, ATS 25-40, Omni 40-58 ("80s" heard for ATS and "A me channel" for Omni-Channel are understood; "In admin" inside Omni stays Omni)',
    d && d.products.HRMS && near(d.products.HRMS.segments[0][0], 4.9) && near(d.products.HRMS.segments[0][1], 24.9) && d.products.ATS && near(d.products.ATS.segments[0][0], 24.9) && near(d.products.ATS.segments[0][1], 39.85)
    && d.products.OMNI && d.products.OMNI.segments.length === 1 && near(d.products.OMNI.segments[0][0], 39.85) && near(d.products.OMNI.segments[0][1], 57.95), d && Object.fromEntries(Object.entries(d.products).map(([k, v]) => [k, v.segments])));
  check('10 each product\'s text comes from its own narration only (HRMS text speaks of payroll, not of WhatsApp)', d && /payroll|payslips/i.test([d.products.HRMS.about, ...d.products.HRMS.features].join(' ')) && !/whatsapp/i.test(JSON.stringify(d.products.HRMS)) && /whatsapp/i.test(JSON.stringify(d.products.OMNI)), d && d.products.HRMS);
  check('11 the speech-to-text slips are fixed in the text ("80s" -> ATS, "A me channel" -> Omni-Channel)', d && /\bATS\b/.test(d.products.ATS.narration) && !/80s/.test(d.products.ATS.narration) && /Omni-Channel/.test(d.products.OMNI.narration), d && [d.products.ATS.narration, d.products.OMNI.narration]);
  const live = await call('GET', '/crm/products?all=1', null, tA);
  check('12 nothing changed on the live products yet', JSON.stringify(live.body.products.find((p) => p.key === 'HRMS')) === JSON.stringify(hrmsBefore));
  const sv = await fetch(`http://localhost:${PORT}${job.srcUrl}`, { headers: { Range: 'bytes=0-99' } });
  check('13 the manager can play the uploaded video in the draft (signed link, in parts)', sv.status === 206, sv.status);

  // ---- save
  const draftIn = { intro: d.intro, outro: d.outro, products: { HRMS: { ...d.products.HRMS, about: 'HRMS from the video.', faq: 'Q: Does payroll do PF?\nA: Yes, PF and ESI.' }, ATS: d.products.ATS, OMNI: d.products.OMNI } };
  const bad = await call('POST', `/crm/product-videos/${id}/apply`, { draft: { ...draftIn, products: { ...draftIn.products, HRMS: { ...draftIn.products.HRMS, segments: [[30, 20]] } } }, use: { HRMS: { video: true } } }, tA);
  check('14 a part that ends before it starts is refused', bad.status === 400, bad.body);
  check('15 nothing ticked is refused', (await call('POST', `/crm/product-videos/${id}/apply`, { draft: draftIn, use: {} }, tA)).status === 400);
  const ap = await call('POST', `/crm/product-videos/${id}/apply`, { draft: draftIn, use: { HRMS: { video: true, text: true }, ATS: { video: true, text: false }, OMNI: { video: false, text: false } } }, tA);
  const afterText = await call('GET', '/crm/products?all=1', null, tA);
  const h1 = afterText.body.products.find((p) => p.key === 'HRMS');
  check('16 Save: the HRMS text is live at once; the Q&A is added to the written one; the prices are not touched', ap.status === 200 && h1.about === 'HRMS from the video.' && /Does payroll do PF/.test(h1.faq) && (!hrmsBefore.faq || h1.faq.includes(hrmsBefore.faq.slice(0, 40))) && JSON.stringify(h1.plans) === JSON.stringify(hrmsBefore.plans), { ap: ap.body, about: h1.about });
  const doneJob = await until(tA, id, ['done', 'failed'], 240000);
  const after = await call('GET', '/crm/products?all=1', null, tA);
  const hP = after.body.products.find((p) => p.key === 'HRMS'); const aP = after.body.products.find((p) => p.key === 'ATS'); const oP = after.body.products.find((p) => p.key === 'OMNI');
  const hFile = hP.videoFile ? path.join(VID, hP.videoFile) : '';
  const aFile = aP.videoFile ? path.join(VID, aP.videoFile) : '';
  check('17 the clips are made: HRMS and ATS have new clips, Omni-Channel is not touched', doneJob && doneJob.status === 'done' && /^HRMS-/.test(hP.videoFile || '') && /^ATS-/.test(aP.videoFile || '') && !/^OMNI-/.test(oP.videoFile || '') && fs.existsSync(hFile) && fs.existsSync(aFile), { job: doneJob && [doneJob.status, doneJob.step, doneJob.error], h: hP.videoFile, a: aP.videoFile, o: oP.videoFile });
  const hd = durationOf(hFile); const ad = durationOf(aFile);
  check('18 each clip = intro + its parts + closing (HRMS about 4.9 + 20 + 6.1 = 31 s; ATS about 4.9 + 15 + 6.1 = 26 s)', Math.abs(hd - 31) < 1.5 && Math.abs(ad - 26) < 1.5, { hd, ad });
  check('19 the ATS text was not changed (only its video was ticked)', aP.about === before.body.products.find((p) => p.key === 'ATS').about);
  const parts = fs.readdirSync(VID).filter((f) => f.endsWith('.parts'));
  check('20 no pieces are left behind', parts.length === 0, parts);

  // ---- a product's own video
  const one = fs.readFileSync(SINGLE);
  const s2 = await call('POST', '/crm/product-videos', { kind: 'single', key: 'OMNI', name: 'omni-own.mp4', size: one.length }, tA);
  await call('PUT', `/crm/product-videos/${s2.body.id}/chunk?offset=0`, one, tA);
  await call('POST', `/crm/product-videos/${s2.body.id}/finish`, null, tA);
  const j2 = await until(tA, s2.body.id, ['draft', 'failed']);
  check('21 a product\'s own video: one part, the whole video, no intro or closing', j2 && j2.status === 'draft' && j2.draft.products.OMNI && j2.draft.products.OMNI.segments.length === 1 && j2.draft.products.OMNI.segments[0][0] === 0 && Math.abs(j2.draft.products.OMNI.segments[0][1] - 12) < 1 && !j2.draft.intro, j2 && j2.draft);
  await call('POST', `/crm/product-videos/${s2.body.id}/apply`, { draft: { products: { OMNI: j2.draft.products.OMNI } }, use: { OMNI: { video: true } } }, tA);
  const j2d = await until(tA, s2.body.id, ['done', 'failed'], 120000);
  const o2 = (await call('GET', '/crm/products?all=1', null, tA)).body.products.find((p) => p.key === 'OMNI');
  check('22 Save: Omni-Channel plays its own new clip', j2d && j2d.status === 'done' && /^OMNI-/.test(o2.videoFile || '') && Math.abs(durationOf(path.join(VID, o2.videoFile)) - 12) < 1.5, { j: j2d && [j2d.status, j2d.error], f: o2.videoFile });
  const list = await call('GET', '/crm/product-videos', null, tA);
  check('23 the uploads list shows both, newest first', list.status === 200 && list.body.jobs.length >= 2 && list.body.jobs[0].id === s2.body.id);
  const del = await call('DELETE', `/crm/product-videos/${id}`, null, tA);
  check('24 removing an upload keeps the live clips', del.status === 200 && fs.existsSync(hFile) && !fs.existsSync(path.join(VID, 'sources', `${id}.mp4`)), del.body);

  // ==== any video, any time (founder 2026-11-17: "whatever video we want to upload in future") ====
  const upload = async (buf, body) => {
    const s = await call('POST', '/crm/product-videos', { ...body, size: buf.length }, tA);
    if (s.status !== 200) return { start: s };
    await call('PUT', `/crm/product-videos/${s.body.id}/chunk?offset=0`, buf, tA);
    await call('POST', `/crm/product-videos/${s.body.id}/finish`, null, tA);
    return { id: s.body.id, job: await until(tA, s.body.id, ['draft', 'failed']) };
  };
  // formats and sizes
  const avi = await call('POST', '/crm/product-videos', { kind: 'all', name: 'Demo.AVI', size: 1000 }, tA);
  const big = await call('POST', '/crm/product-videos', { kind: 'all', name: 'huge.mp4', size: 4 * 1024 * 1024 * 1024 }, tA);
  const exe = await call('POST', '/crm/product-videos', { kind: 'all', name: 'setup.exe', size: 1000 }, tA);
  check('25 AVI is accepted; a 4 GB file is refused with the limit and what to do; a non-video is refused', avi.status === 200 && big.status === 400 && /3 GB/.test(big.body.error) && /export it smaller/.test(big.body.error) && exe.status === 400, [avi.status, big.body, exe.status]);
  if (avi.body.id) await call('DELETE', `/crm/product-videos/${avi.body.id}`, null, tA).catch(() => null);
  await prisma.$executeRawUnsafe('UPDATE "CrmVideoJob" SET "status" = \'failed\' WHERE "status" = \'uploading\'');

  // a new product
  const np = await call('POST', '/crm/products', { name: 'TeamLink Accounts' }, tA);
  const dupP = await call('POST', '/crm/products', { name: 'teamlink accounts' }, tA);
  const noP = await call('POST', '/crm/products', { name: 'Something' }, tP);
  check('26 + Add product: TeamLink Accounts gets its own key; the same name twice is refused; only managers', np.status === 200 && np.body.product.key === 'ACCOUNTS' && np.body.product.plans.length === 0 && dupP.status === 409 && noP.status === 403, [np.body, dupP.status, noP.status]);
  // the all-products video again, now with Accounts in it: the split finds it by its name and writes its text
  fs.writeFileSync(FAKE, JSON.stringify([
    { s: 0.3, e: 4.6, t: 'This is Team Link Enterprise, module by module.' },
    { s: 5.2, e: 24.6, t: 'In HRMS, the HRMS dashboard shows headcount, attendance, leave and payroll.' },
    { s: 25.2, e: 32.0, t: 'In accounts, the dashboard tracks invoices, collections, GST and TDS.' },
    { s: 32.0, e: 39.5, t: 'Journal and ledger gives the trial balance and the profit and loss.' },
    { s: 40.2, e: 57.6, t: 'A me channel opens on its dashboard; the WhatsApp inbox holds every chat.' },
    { s: 58.3, e: 63.5, t: 'Every module, every tab, one login.' },
  ]));
  const again = await upload(file, { kind: 'all', name: 'all-products-v2.mp4' });
  const d2 = again.job && again.job.draft;
  check('27 the all-products video uploaded again is split again, and finds the new product by its name (Accounts 25-40)', d2 && d2.products.ACCOUNTS && near(d2.products.ACCOUNTS.segments[0][0], 24.9) && near(d2.products.ACCOUNTS.segments[0][1], 39.85) && /invoices|ledger/i.test(d2.products.ACCOUNTS.narration) && (d2.notes || []).some((n) => /ATS was not found/.test(n)), d2 && { p: Object.fromEntries(Object.entries(d2.products).map(([k, v]) => [k, v.segments])), n: d2.notes });
  await call('POST', `/crm/product-videos/${again.id}/apply`, { draft: { intro: d2.intro, outro: d2.outro, products: { ACCOUNTS: { ...d2.products.ACCOUNTS, about: 'Accounts from the video.' } } }, use: { ACCOUNTS: { video: true, text: true } } }, tA);
  await until(tA, again.id, ['done', 'failed'], 120000);
  const acc = (await call('GET', '/crm/products?all=1', null, tA)).body.products.find((p) => p.key === 'ACCOUNTS');
  check('28 Save: the new product has its clip and its text', /^ACCOUNTS-/.test(acc.videoFile || '') && acc.about === 'Accounts from the video.' && fs.existsSync(path.join(VID, acc.videoFile)), acc);

  // another video for a product, next to its demo
  const hMain = (await call('GET', '/crm/products?all=1', null, tA)).body.products.find((p) => p.key === 'HRMS').videoFile;
  const ex = await upload(one, { kind: 'extra', key: 'HRMS', name: 'payroll.mov', title: 'Payroll walk-through' });
  check('29 another video for HRMS: one part, no text to write', ex.job && ex.job.status === 'draft' && ex.job.draft.products.HRMS.noText === true && ex.job.draft.target.title === 'Payroll walk-through', ex.job && ex.job.draft);
  await call('POST', `/crm/product-videos/${ex.id}/apply`, { draft: { products: { HRMS: ex.job.draft.products.HRMS }, title: 'Payroll walk-through' }, use: { HRMS: { video: true, text: true } } }, tA);
  await until(tA, ex.id, ['done', 'failed'], 120000);
  const h2 = (await call('GET', '/crm/products?all=1', null, tA)).body.products.find((p) => p.key === 'HRMS');
  check('30 Save: HRMS keeps its demo and gets "Payroll walk-through" under it (its text is not rewritten)', h2.videoFile === hMain && h2.extraVideos.length === 1 && h2.extraVideos[0].title === 'Payroll walk-through' && h2.about === 'HRMS from the video.', { v: h2.videoFile, x: h2.extraVideos, a: h2.about });
  // the company video
  const co = await upload(one, { kind: 'company', name: 'about-us.webm', title: 'About TeamLink Consultants' });
  await call('POST', `/crm/product-videos/${co.id}/apply`, { draft: { products: { COMPANY: co.job.draft.products.COMPANY }, title: 'About TeamLink Consultants' }, use: { COMPANY: { video: true } } }, tA);
  await until(tA, co.id, ['done', 'failed'], 120000);
  const cst = (await call('GET', '/crm/products-settings', null, tA)).body.settings;
  check('31 a company video: saved for the top of every demo page', /^COMPANY-/.test(cst.companyVideoFile || '') && cst.companyVideoTitle === 'About TeamLink Consultants', st);
  // what a lead sees
  const L = await call('POST', '/crm/leads', { company: `ZZTEST PV ${process.pid}`, contactName: 'Pv Lead', phone: `91${String(Date.now()).slice(-8)}`, source: 'Website' }, tA);
  await call('POST', `/crm/leads/${L.body.lead.id}/products`, { products: ['HRMS', 'ACCOUNTS'] }, tA);
  const dm = await call('POST', `/crm/leads/${L.body.lead.id}/demo`, { channel: 'link' }, tA);
  const dt = dm.body.url.split('/').pop();
  const page = await fetch(dm.body.url).then((r) => r.text());
  const xv = await fetch(`${API}/crm-public/demo/${dt}/xvideo/HRMS/0`, { headers: { Range: 'bytes=0-9' } });
  const cv = await fetch(`${API}/crm-public/demo/${dt}/company-video`, { headers: { Range: 'bytes=0-9' } });
  const xo = await fetch(`${API}/crm-public/demo/${dt}/xvideo/OMNI/0`);
  check('32 the demo page: the company video first, HRMS with "More videos", the new product Accounts; videos stream; another product\'s video is not given', /About TeamLink Consultants/.test(page) && /More videos/.test(page) && /Payroll walk-through/.test(page) && /TeamLink Accounts/.test(page) && xv.status === 206 && cv.status === 206 && xo.status === 404, [xv.status, cv.status, xo.status, /About TeamLink Consultants/.test(page), /More videos/.test(page), /Payroll walk-through/.test(page), /TeamLink Accounts/.test(page), (page.match(/<h2>[^<]*<\/h2>/g) || []).slice(0, 8)]);
  const wc = await call('GET', '/crm/products/COMPANY/watch', null, tA);
  const wx = await call('GET', '/crm/products/HRMS/watch?extra=0', null, tA);
  const wcs = wc.body.url ? (await fetch(`http://localhost:${PORT}${wc.body.url}`, { headers: { Range: 'bytes=0-9' } })).status : 0;
  const wxs = wx.body.url ? (await fetch(`http://localhost:${PORT}${wx.body.url}`, { headers: { Range: 'bytes=0-9' } })).status : 0;
  check('33 the team can watch the company video and the other videos from Our products', wcs === 206 && wxs === 206, [wc.body, wx.body, wcs, wxs]);
  const rmx = await call('DELETE', '/crm/products/HRMS/videos/0', null, tA);
  await call('PUT', '/crm/products-settings', { companyVideoFile: '' }, tA);
  const h3 = (await call('GET', '/crm/products?all=1', null, tA)).body.products.find((p) => p.key === 'HRMS');
  const st2 = (await call('GET', '/crm/products-settings', null, tA)).body.settings;
  const page2 = await fetch(dm.body.url).then((r) => r.text());
  check('34 remove: the other video and the company video come off the demo page', rmx.status === 200 && h3.extraVideos.length === 0 && !st2.companyVideoFile && !/More videos/.test(page2) && !/About TeamLink Consultants/.test(page2), [rmx.status, h3.extraVideos, st2.companyVideoFile]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
