// INTERVIEW DATE COMPULSORY (founder 2026-11-26): moving a person INTO Interview scheduled needs a date and time that is not over.
//   TEST_SOURCE_DB=<a .db file> node scripts/interview-date-required-test.js       (a COPY is used; the source is never written)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `ivdate-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
const DB_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.DATABASE_URL = DB_URL;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.DATABASE_URL = DB_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'ivdate-test-only-secret';
const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const API = `http://localhost:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

(async () => {
  const { PrismaClient } = require(path.join(__dirname, '..', 'node_modules/@prisma/client'));
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`${API}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(1000); }
    if (!up) throw new Error(`server did not start
${log.slice(-600)}`);
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    await prisma.user.update({ where: { id: sa.id }, data: { passwordChangedAt: new Date() } });
    const tok = require('jsonwebtoken').sign({ id: sa.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const applyStageMove = async (_u, id, body) => { const r = await fetch(`${API}/applications/${id}/stage`, { method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const user = null;
    const apps = await prisma.application.findMany({ where: { stage: 'CLIENT_SHORTLISTED' }, take: 4, select: { id: true, interviewAt: true } });
    if (apps.length < 3) throw new Error('the copy needs 3 applications at Client shortlisted');
    await prisma.application.updateMany({ where: { id: { in: apps.map((a) => a.id) } }, data: { interviewAt: null } });
    const move = (id, extra) => applyStageMove(user, id, { stage: 'INTERVIEW_SCHEDULED', comment: 'test', ...extra }, { silent: true });

    const r1 = await move(apps[0].id, {});
    check('no date: refused with INTERVIEW_DATE_REQUIRED', r1.status === 400 && r1.body.code === 'INTERVIEW_DATE_REQUIRED', r1);
    check('... and the person stays where they were', (await prisma.application.findUnique({ where: { id: apps[0].id } })).stage === 'CLIENT_SHORTLISTED');

    const r2 = await move(apps[1].id, { interviewAt: new Date(Date.now() - 3 * 3600000).toISOString() });
    check('a date already over: refused with INTERVIEW_DATE_PAST', r2.status === 400 && r2.body.code === 'INTERVIEW_DATE_PAST', r2);

    const fut = new Date(Date.now() + 26 * 3600000);
    const r3 = await move(apps[2].id, { interviewAt: fut.toISOString() });
    const a3 = await prisma.application.findUnique({ where: { id: apps[2].id } });
    check('a future date: moved, and the date saved', r3.status === 200 && a3.stage === 'INTERVIEW_SCHEDULED' && a3.interviewAt && Math.abs(new Date(a3.interviewAt) - fut) < 1000, [r3.status, r3.body && r3.body.error, a3.stage]);

    const r4 = await move(apps[0].id, { interviewAt: new Date(Date.now() - 10 * 60000).toISOString() });
    check('an interview being recorded as it starts (10 minutes ago) is allowed', r4.status === 200, [r4.status, r4.body && r4.body.error]);

    if (apps[3]) {
      const r5 = await applyStageMove(user, apps[3].id, { stage: 'HOLD', reasonCategory: 'Client on hold', reasonDetail: 'test', comment: 'test', reviewOn: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) }, { silent: true });
      check('other moves are not touched (Hold works without any date)', r5.status === 200, [r5.status, r5.body && r5.body.error]);
    }
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.stack || e.message}`);
  } finally {
    await prisma.$disconnect();
    server.kill(); await sleep(500);
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
