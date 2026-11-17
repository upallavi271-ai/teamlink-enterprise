#!/usr/bin/env node
/**
 * ENCRYPTED OFF-SITE BACKUP (utils/offsiteBackup.js) - founder 2026-11-17 "Security first".
 * Makes a backup of a COPY of the sandbox database into a temp folder, encrypts it, runs the restore drill, and proves a wrong
 * passphrase or a changed byte cannot be restored. The S3 upload itself needs real storage and is not exercised here.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/offsite-backup-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-offsite-${process.pid}.db`);
const ROOT = path.join(os.tmpdir(), `zz-offsite-root-${process.pid}`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, BACKUP_DIR: ROOT, BACKUP_ENC_KEY: 'zz-test-passphrase-0123456789' });
const B = require('../src/utils/backup');
const O = require('../src/utils/offsiteBackup');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
function done(code) {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* none */ }
  process.exit(code);
}

(async () => {
  const short = await O.encryptFile(COPY, path.join(os.tmpdir(), 'zz-x.tlbk'), 'short').then(() => 'took it').catch((e) => e.message);
  check('a short passphrase is refused', /at least 16/.test(short), short);
  const b = await B.makeBackup({ reason: 'test' });
  check('a backup is made', !!b.name);
  const p = await O.pushLatest();
  check('it is encrypted (kept on this server: no storage set)', p.bytes > 0 && p.uploaded === false && fs.existsSync(p.file), p);
  const raw = fs.readFileSync(p.file);
  check('the encrypted file does not contain readable SQLite', !raw.includes(Buffer.from('SQLite format 3')) && raw.subarray(0, 5).toString() === 'TLBK1');
  const d = await O.drill();
  check('the restore drill decrypts it and the counts match the backup', d.ok && d.counts && d.counts.User > 0, d);
  const out = path.join(os.tmpdir(), `zz-dec-${process.pid}.db`);
  const wrong = await O.decryptFile(p.file, out, 'not-the-right-passphrase-xx').then(() => 'opened').catch(() => 'refused');
  check('a wrong passphrase cannot open it', wrong === 'refused');
  const bad = Buffer.from(raw); bad[Math.floor(bad.length / 2)] ^= 0xff; // eslint-disable-line no-bitwise
  const badFile = `${p.file}.bad`; fs.writeFileSync(badFile, bad);
  const tampered = await O.decryptFile(badFile, out, process.env.BACKUP_ENC_KEY).then(() => 'opened').catch(() => 'refused');
  check('one changed byte makes it refuse (authenticated encryption)', tampered === 'refused');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(out + s); } catch { /* none */ } }
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'status.json'), 'utf8'));
  check('status.json records the encrypted copy and the drill', st.offsite && st.offsite.state === 'encrypted on this server only' && st.offsite.drill && st.offsite.drill.ok, st.offsite);
  delete process.env.BACKUP_ENC_KEY;
  const none = await O.pushLatest();
  check('without a passphrase nothing is sent and the status says what to set', none.skipped && /BACKUP_ENC_KEY/.test(JSON.parse(fs.readFileSync(path.join(ROOT, 'status.json'), 'utf8')).offsite.note));
  console.log(`\n${total - failed}/${total} passed`);
  done(failed ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
