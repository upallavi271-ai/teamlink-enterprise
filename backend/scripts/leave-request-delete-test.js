#!/usr/bin/env node
/**
 * Delete a leave request made twice (routes/leave.js DELETE /:id). SANDBOX ONLY: a COPY of the sandbox database, on a private port.
 *   node scripts/leave-request-delete-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = process.env.TEST_SOURCE_DB || path.resolve(__dirname, '..', 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-lr-${process.pid}.db`).split(path.sep).join('/');
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4092;
const SECRET = 'zz-lr-secret';
const env = { ...process.env, PORT: String(PORT), TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY}`, JWT_SECRET: SECRET };
Object.assign(process.env, env);
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}\n      ${JSON.stringify(extra)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    const tokenOf = async (u) => {
      await prisma.user.update({ where: { id: u.id }, data: { passwordChangedAt: new Date(), passwordResetRequired: false } });
      return jwt.sign(tokenPayload(await resolveIdentity(u.id, u)), SECRET, { expiresIn: '1h' });
    };
    const boss = (await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' } })).find((u) => !/zz/i.test(u.name));
    const hr = await prisma.user.findFirst({ where: { role: { notIn: ['SUPER_ADMIN', 'ADMIN'] }, status: 'Active', hrmsRole: 'HR' } });
    const T = { boss: await tokenOf(boss), hr: hr ? await tokenOf(hr) : null };
    const call = async (method, p, tok) => {
      for (let i = 0; i < 60; i += 1) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { Authorization: `Bearer ${tok}` } });
          return { status: r.status, body: await r.json().catch(() => ({})) };
        } catch { await sleep(1000); }
      }
      throw new Error('server did not start');
    };
    const emp = await prisma.employee.findFirst({ where: { userId: { not: null } }, select: { id: true } });
    // plain SQL: the sandbox copy may be a few columns behind the schema
    let n = 0;
    const mk = async (status) => {
      n += 1;
      const id = `zzlr${Date.now()}${n}`;
      await prisma.$executeRawUnsafe('INSERT INTO "LeaveRequest" ("id", "employeeId", "type", "fromDate", "toDate", "days", "status") VALUES (?, ?, ?, ?, ?, 1, ?)', id, emp.id, 'Sick Leave', '2026-11-25', '2026-11-25', status);
      return { id };
    };
    const exists = async (id) => (await prisma.$queryRawUnsafe('SELECT "id" FROM "LeaveRequest" WHERE "id" = ?', id)).length > 0;
    const twice = await mk('Pending');
    await prisma.approvalStep.create({ data: { workflow: 'leave', recordId: twice.id, level: 1, levelId: 'hr', label: 'HR', status: 'Pending' } }).catch(() => null);
    if (T.hr) {
      const r0 = await call('DELETE', `/leave/${twice.id}`, T.hr);
      check('HR cannot delete a request (Super Admin only)', r0.status === 403 && await exists(twice.id), r0);
    }
    const r1 = await call('DELETE', `/leave/${twice.id}`, T.boss);
    check('the Super Admin deletes the pending one: it is gone, with its approval steps',
      r1.status === 200 && !(await exists(twice.id)) && (await prisma.approvalStep.count({ where: { workflow: 'leave', recordId: twice.id } })) === 0, r1);
    const approved = await mk('Approved');
    const r2 = await call('DELETE', `/leave/${approved.id}`, T.boss);
    check('an approved leave is refused (cancel it first, so the days go back)', r2.status === 409 && await exists(approved.id), r2);
  } catch (e) { failed += 1; console.log('FAIL  ', e.message); } finally {
    server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
