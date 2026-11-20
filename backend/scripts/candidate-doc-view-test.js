#!/usr/bin/env node
/**
 * View on a candidate's documents (routes/candidateRecord.js): a Resume row named on the Add Candidate form opens the resume file on
 * the Resume tab. SANDBOX ONLY: a COPY of the sandbox database, on a private port.
 *   node scripts/candidate-doc-view-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = process.env.TEST_SOURCE_DB || path.resolve(__dirname, '..', 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-dv-${process.pid}.db`).split(path.sep).join('/');
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4093;
const SECRET = 'zz-dv-secret';
const env = { ...process.env, PORT: String(PORT), TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY}`, JWT_SECRET: SECRET };
Object.assign(process.env, env);
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}\n      ${JSON.stringify(extra)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = String(Date.now()).slice(-6);
const run = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);

(async () => {
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    const boss = (await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' } })).find((u) => !/zz/i.test(u.name));
    await prisma.user.update({ where: { id: boss.id }, data: { passwordChangedAt: new Date(), passwordResetRequired: false } });
    const token = jwt.sign(tokenPayload(await resolveIdentity(boss.id, boss)), SECRET, { expiresIn: '1h' });
    const get = async (p) => {
      for (let i = 0; i < 60; i += 1) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json().catch(() => ({})) }; } catch { await sleep(1000); }
      }
      throw new Error('server did not start');
    };
    // plain SQL: the sandbox copy may be a few columns behind the schema
    const withResume = `zzdv1${R}`; const bare = `zzdv2${R}`;
    await run('INSERT INTO "Candidate" ("id", "name") VALUES (?, ?)', withResume, `ZZTEST Doc View ${R}`);
    await run('INSERT INTO "Candidate" ("id", "name") VALUES (?, ?)', bare, `ZZTEST Doc Bare ${R}`);
    await run('INSERT INTO "CandidateDocument" ("id", "candidateId", "docType", "name") VALUES (?, ?, ?, ?)', `zzd1${R}`, withResume, 'Resume', 'G.V.KEERTHI.pdf');
    await run('INSERT INTO "CandidateDocument" ("id", "candidateId", "docType", "name") VALUES (?, ?, ?, ?)', `zzd2${R}`, bare, 'Resume', 'nofile.pdf');
    await run('INSERT INTO "CandidateResume" ("id", "candidateId", "kind", "file", "fileName") VALUES (?, ?, ?, ?, ?)', `zzr1${R}`, withResume, 'ORIGINAL', 'stored/x.pdf', 'G.V.KEERTHI.pdf');
    const a = await get(`/candidates/${withResume}/record`);
    const d1 = (a.body.documents || [])[0] || {};
    check('a Resume row named on the Add Candidate form points at the resume file', a.status === 200 && d1.resumeId === `zzr1${R}` && d1.hasFile === false && d1.fileName === 'G.V.KEERTHI.pdf', { status: a.status, d1 });
    const b = await get(`/candidates/${bare}/record`);
    const d2 = (b.body.documents || [])[0] || {};
    check('with no resume file anywhere, nothing to open (the page says so)', b.status === 200 && !d2.resumeId && d2.hasFile === false, { status: b.status, d2 });
  } catch (e) { failed += 1; console.log('FAIL  ', e.message); } finally {
    server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
