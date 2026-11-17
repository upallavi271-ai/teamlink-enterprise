// ---------------------------------------------------------------------------
// ENCRYPTED OFF-SITE BACKUP (founder 2026-11-17, "Security first": the audit's "backups unencrypted, on the same server, no
// DR" gap). docs/DISASTER-RECOVERY.md is the plain-words plan that goes with it.
//
// After the daily backup (utils/backup.js, scripts/backup.js) passes its restore test:
//   1. its database copy (+ manifest) is packed, gzipped and ENCRYPTED: AES-256-GCM, key from the passphrase in
//      BACKUP_ENC_KEY through scrypt (a new random salt and IV per file). Without the passphrase the file is unreadable.
//      File: <BACKUP_DIR>/offsite/<set>.tlbk  (the newest 7 are kept on the server too)
//   2. it is UPLOADED to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi ...) when
//      BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_KEY_ID / BACKUP_S3_SECRET (+ BACKUP_S3_REGION) are set. Only the
//      encrypted file ever leaves the server.
//   3. a RESTORE DRILL decrypts the newest encrypted file into a temp folder, runs SQLite's integrity check and compares the
//      row counts with the manifest (npm run backup:drill). The result is kept in status.json -> offsite.
// Nothing happens without BACKUP_ENC_KEY: the status then says what to set. The passphrase must be kept OFF this server too
// (password manager + printed copy with the founder) - a backup whose key is lost with the server cannot be restored.
//
//   encryptFile(src, dest, pass) / decryptFile(src, dest, pass)
//   pushLatest({ log })   -> { file, bytes, uploaded, key }
//   drill({ log })        -> { ok, counts, problems }
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('TLBK1');
const KEEP_LOCAL = 7;

const passphrase = () => String(process.env.BACKUP_ENC_KEY || '');
const keyOf = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });

// [MAGIC 5][salt 16][iv 12][ ciphertext of gzip(data) ][tag 16]
async function encryptFile(src, dest, pass) {
  if (!pass || pass.length < 16) throw new Error('BACKUP_ENC_KEY must be a passphrase of at least 16 characters.');
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(pass, salt), iv);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), cipher, out, { end: false }).catch(async (e) => { out.destroy(); throw e; });
  await new Promise((res, rej) => { out.end(cipher.getAuthTag(), (e) => (e ? rej(e) : res())); });
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}
async function decryptFile(src, dest, pass) {
  const size = fs.statSync(src).size;
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(33); fs.readSync(fd, head, 0, 33, 0);
  const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 5).equals(MAGIC)) throw new Error('This is not a TeamLink encrypted backup.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(pass, head.subarray(5, 21)), head.subarray(21, 33));
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(src, { start: 33, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(dest));
}

// ---- S3-compatible upload (AWS Signature V4, one PUT, payload streamed) ----
const s3Conf = () => ({
  endpoint: String(process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  keyId: process.env.BACKUP_S3_KEY_ID || '',
  secret: process.env.BACKUP_S3_SECRET || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
  prefix: (process.env.BACKUP_S3_PREFIX || 'teamlink/').replace(/^\/+/, ''),
});
const s3Ready = () => { const c = s3Conf(); return !!(c.endpoint && c.bucket && c.keyId && c.secret); };
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function s3Put(file, objectKey) {
  const c = s3Conf();
  const u = new URL(`${c.endpoint}/${c.bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const size = fs.statSync(file).size;
  const headers = { host: u.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, 'content-length': String(size), 'content-type': 'application/octet-stream' };
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', u.pathname, '', ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSig = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, day), c.region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${crypto.createHmac('sha256', kSig).update(toSign).digest('hex')}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'PUT', hostname: u.hostname, port: u.port || 443, path: u.pathname, headers }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode }) : reject(new Error(`Storage refused the upload (${res.statusCode}): ${body.slice(0, 200)}`))));
    });
    req.on('error', reject);
    fs.createReadStream(file).pipe(req);
  });
}

function offsiteDir() {
  const B = require('./backup'); // eslint-disable-line global-require
  const d = path.join(B.backupRoot(), 'offsite');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function setStatus(patch) {
  try {
    const B = require('./backup'); // eslint-disable-line global-require
    const f = path.join(B.backupRoot(), 'status.json');
    const cur = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } })();
    cur.offsite = { ...(cur.offsite || {}), ...patch };
    fs.writeFileSync(f, JSON.stringify(cur, null, 2));
  } catch { /* the log line still says it */ }
}

async function pushLatest({ log = () => {} } = {}) {
  const pass = passphrase();
  if (!pass) { setStatus({ state: 'not set up', note: 'Set BACKUP_ENC_KEY (and the BACKUP_S3_* storage) to keep an encrypted copy off this server.' }); return { skipped: 'no BACKUP_ENC_KEY' }; }
  const B = require('./backup'); // eslint-disable-line global-require
  const set = B.listSets()[0];
  if (!set) throw new Error('There is no backup to send yet.');
  const dir = offsiteDir();
  const file = path.join(dir, `${set.name}.tlbk`);
  log(`encrypting ${set.name} ...`);
  // one file: the database copy; the manifest travels beside it in clear (counts only, no personal data)
  const bytes = await encryptFile(path.join(set.dir, 'teamlink.db'), file, pass);
  fs.writeFileSync(`${file}.manifest.json`, JSON.stringify({ set: set.name, createdAt: set.createdAt, counts: (set.manifest.db && set.manifest.db.counts) || null }, null, 2));
  let uploaded = false; let key = null;
  if (s3Ready()) {
    key = `${s3Conf().prefix}${set.name}.tlbk`;
    log(`uploading ${(bytes / 1048576).toFixed(1)} MB to off-site storage ...`);
    await s3Put(file, key);
    await s3Put(`${file}.manifest.json`, `${key}.manifest.json`);
    uploaded = true;
  }
  // keep the newest few encrypted files here
  fs.readdirSync(dir).filter((n) => n.endsWith('.tlbk')).sort().reverse().slice(KEEP_LOCAL)
    .forEach((n) => { [n, `${n}.manifest.json`].forEach((x) => { try { fs.unlinkSync(path.join(dir, x)); } catch { /* gone */ } }); });
  setStatus({ state: uploaded ? 'off-site' : 'encrypted on this server only', set: set.name, at: new Date().toISOString(), bytes, uploaded, key, note: uploaded ? '' : 'Add the BACKUP_S3_* storage settings so the encrypted copy also leaves this server.' });
  return { file, bytes, uploaded, key };
}

async function drill({ log = () => {} } = {}) {
  const pass = passphrase();
  if (!pass) return { ok: false, problems: ['BACKUP_ENC_KEY is not set.'] };
  const dir = offsiteDir();
  const newest = fs.readdirSync(dir).filter((n) => n.endsWith('.tlbk')).sort().reverse()[0];
  if (!newest) return { ok: false, problems: ['No encrypted backup yet.'] };
  const tmp = path.join(os.tmpdir(), `tl-drill-${process.pid}.db`);
  const problems = []; let counts = null; const t = Date.now();
  try {
    log(`decrypting ${newest} ...`);
    await decryptFile(path.join(dir, newest), tmp, pass);
    const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
    const db = new DatabaseSync(tmp, { readOnly: true });
    const ic = db.prepare('PRAGMA integrity_check').get();
    if (!ic || Object.values(ic)[0] !== 'ok') problems.push(`integrity check: ${JSON.stringify(ic)}`);
    const B = require('./backup'); // eslint-disable-line global-require
    counts = {};
    B.KEY_TABLES.forEach(([table]) => { try { counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n; } catch (e) { problems.push(`${table}: ${e.message}`); } });
    db.close();
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(dir, `${newest}.manifest.json`), 'utf8')); } catch { /* none */ }
    const want = man && man.counts;
    if (want && typeof want === 'object') Object.entries(counts).forEach(([tb, n]) => { if (want[tb] != null && Number(want[tb]) !== Number(n)) problems.push(`${tb}: ${n} rows, the backup said ${want[tb]}`); });
  } catch (e) { problems.push(e.message); } finally { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* none */ } } }
  const out = { ok: !problems.length, file: newest, counts, problems, seconds: Math.round((Date.now() - t) / 1000), at: new Date().toISOString() };
  setStatus({ drill: out });
  return out;
}

module.exports = { encryptFile, decryptFile, pushLatest, drill, s3Ready, s3Put, passphrase };
