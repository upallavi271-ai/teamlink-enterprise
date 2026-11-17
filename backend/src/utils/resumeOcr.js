// ---------------------------------------------------------------------------
// OCR FOR SCANNED RESUMES (Mandatory ATS gap, 2026-11-17)
//
// A scanned PDF or a photo of a resume has no text layer, so pdf-parse gives
// nothing and the free parser has nothing to read. This module reads the text
// off the picture with the free `tesseract` program (and `pdftoppm` from
// poppler-utils to turn a PDF's pages into pictures). It is used ONLY when the
// normal text extraction found (nearly) nothing: resumeParse.extractAndParse.
//
//   status({ fresh })   -> { available, pdf, version, languages[], use, why }
//   ocrBuffer(buf, kind) -> { text, pages, languages, error, notInstalled, busy }
//
// RULES
//   * Never crashes or blocks an upload: every failure comes back as `error`
//     (and `notInstalled` when the program is missing) and the upload goes on.
//   * One OCR at a time (a simple queue) at low priority (`nice -n 19` on
//     Linux), each one stopped after 60 s; at most 4 PDF pages at 200 dpi.
//     A long queue (OCR_MAX_QUEUE, default 25) answers "busy" instead of waiting.
//   * Languages eng+tel+hin when installed (`tesseract --list-langs`), else
//     whatever of them is installed, else eng.
//   * The programs can be pointed elsewhere with OCR_TESSERACT_BIN and
//     OCR_PDFTOPPM_BIN. A path ending in .js is run with this Node (the tests'
//     stand-in programs); anything else is run directly.
//   * Nothing leaves the server: the work files live in a private temp folder
//     that is removed afterwards.
// Install on the server: docs/OCR-SETUP.md.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 60000;
const MAX_PAGES = 4;
const DPI = 200;
const WANT_LANGS = ['eng', 'tel', 'hin'];
const STATUS_TTL_MS = 10 * 60 * 1000;
const NOT_INSTALLED = 'Scanned resume — text could not be read (OCR not installed on the server)';

const tesseractBin = () => String(process.env.OCR_TESSERACT_BIN || 'tesseract').trim();
const pdftoppmBin = () => String(process.env.OCR_PDFTOPPM_BIN || 'pdftoppm').trim();
const maxQueue = () => Math.max(1, Number(process.env.OCR_MAX_QUEUE) || 25);

// The command line for one program: a .js stand-in runs with this Node; on
// Linux the real thing runs under `nice -n 19` so OCR never slows the app.
function commandFor(bin, args, { lowPriority = true } = {}) {
  if (/\.js$/i.test(bin)) return [process.execPath, [bin, ...args]];
  if (lowPriority && process.platform === 'linux' && niceAvailable()) return ['nice', ['-n', '19', bin, ...args]];
  return [bin, args];
}
let niceChecked = null;
function niceAvailable() {
  if (niceChecked !== null) return niceChecked;
  niceChecked = ['/usr/bin/nice', '/bin/nice'].some((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  return niceChecked;
}

// -> { ok, stdout, stderr, code, missing, timedOut }
function run(bin, args, { timeout = TIMEOUT_MS, lowPriority = true } = {}) {
  return new Promise((resolve) => {
    const [cmd, argv] = commandFor(bin, args, { lowPriority });
    let child;
    try {
      child = execFile(cmd, argv, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0 });
        const missing = err.code === 'ENOENT' || (cmd === 'nice' && /No such file|not found/i.test(String(stderr || '')) && err.code === 127);
        return resolve({
          ok: false, stdout: String(stdout || ''), stderr: String(stderr || err.message || ''), code: err.code, missing, timedOut: !!err.killed,
        });
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err && err.message), code: err && err.code, missing: err && err.code === 'ENOENT' });
      return;
    }
    if (child && child.stdin) child.stdin.end();
  });
}

// --- is it installed, and which languages ------------------------------------
let statusCache = null; // { at, value }
function parseLangs(out) {
  return [...new Set(String(out || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^[a-z]{3}(_[a-z]+)?$/i.test(l) && l !== 'osd'))];
}
async function status({ fresh = false } = {}) {
  if (!fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const t = tesseractBin();
  const ver = await run(t, ['--version'], { timeout: 10000, lowPriority: false });
  let value;
  if (!ver.ok && ver.missing) {
    value = {
      available: false, pdf: false, version: null, languages: [], use: null, tesseract: t, pdftoppm: pdftoppmBin(),
      why: 'OCR is not installed on the server (the "tesseract" program was not found).', setup: 'docs/OCR-SETUP.md',
    };
  } else {
    // tesseract 3.x prints the list on stderr, 4+ on stdout
    const ls = await run(t, ['--list-langs'], { timeout: 10000, lowPriority: false });
    const languages = parseLangs(`${ls.stdout}\n${ls.stderr}`);
    const have = WANT_LANGS.filter((l) => languages.includes(l));
    const use = have.length ? (have.includes('eng') ? have : ['eng', ...have]).join('+') : 'eng';
    const pv = await run(pdftoppmBin(), ['-v'], { timeout: 10000, lowPriority: false });
    // pdftoppm -v exits 0 (newer) or 99 (older) and prints its version on stderr; only "not found" means missing
    const pdf = !pv.missing;
    const version = (`${ver.stdout}\n${ver.stderr}`.match(/tesseract\s+v?([\d.]+[\w.-]*)/i) || [])[1] || null;
    value = {
      available: true, pdf, version, languages, use, tesseract: t, pdftoppm: pdftoppmBin(),
      missingLanguages: WANT_LANGS.filter((l) => !languages.includes(l)),
      why: pdf ? null : 'Pictures (JPG / PNG) are read; scanned PDFs need "pdftoppm" (poppler-utils), which was not found.',
      setup: 'docs/OCR-SETUP.md',
    };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// --- one OCR at a time ---------------------------------------------------------
let chain = Promise.resolve();
let waiting = 0;
function enqueue(job) {
  waiting += 1;
  const p = chain.then(job, job);
  chain = p.catch(() => {}).finally(() => { waiting -= 1; });
  return p;
}
const queueLength = () => waiting;

const clean = (t) => String(t || '').replace(/\f/g, '\n').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function ocrJob(buffer, kind) {
  const st = await status();
  if (!st.available) return { text: '', pages: 0, languages: null, error: NOT_INSTALLED, notInstalled: true };
  if (kind === 'pdf' && !st.pdf) return { text: '', pages: 0, languages: null, error: 'Scanned resume — text could not be read (the PDF page reader "pdftoppm" is not installed on the server)', notInstalled: true };
  const started = Date.now();
  const left = () => Math.max(1000, TIMEOUT_MS - (Date.now() - started));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ocr-'));
  try {
    let images = [];
    if (kind === 'pdf') {
      const input = path.join(dir, 'in.pdf');
      fs.writeFileSync(input, buffer, { mode: 0o600 });
      const r = await run(pdftoppmBin(), ['-r', String(DPI), '-f', '1', '-l', String(MAX_PAGES), '-png', input, path.join(dir, 'page')], { timeout: left() });
      if (!r.ok) {
        return { text: '', pages: 0, languages: st.use, error: r.timedOut ? 'Scanned resume — reading the pages took too long (stopped after 60 seconds)' : `Scanned resume — the pages could not be turned into pictures (${String(r.stderr).trim().slice(0, 100)})` };
      }
      images = fs.readdirSync(dir).filter((f) => /^page-\d+\.png$/i.test(f))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])).slice(0, MAX_PAGES).map((f) => path.join(dir, f));
    } else {
      const input = path.join(dir, `in.${kind === 'png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(input, buffer, { mode: 0o600 });
      images = [input];
    }
    if (!images.length) return { text: '', pages: 0, languages: st.use, error: 'Scanned resume — no page could be read' };
    const parts = [];
    for (const img of images) {
      // eslint-disable-next-line no-await-in-loop
      const r = await run(tesseractBin(), [img, 'stdout', '-l', st.use], { timeout: left() });
      if (!r.ok) {
        if (r.timedOut) return { text: clean(parts.join('\n\n')), pages: parts.length, languages: st.use, error: 'Scanned resume — reading the text took too long (stopped after 60 seconds)' };
        return { text: clean(parts.join('\n\n')), pages: parts.length, languages: st.use, error: `Scanned resume — the text could not be read (${String(r.stderr).trim().slice(0, 100)})` };
      }
      parts.push(r.stdout);
      if (Date.now() - started > TIMEOUT_MS) break;
    }
    const text = clean(parts.join('\n\n'));
    return { text, pages: images.length, languages: st.use, error: text ? null : 'Scanned resume — no text was found on the pages' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans its temp folder */ }
  }
}

// The text of a scanned PDF / a photo. kind: 'pdf' | 'jpg' | 'png'.
async function ocrBuffer(buffer, kind) {
  if (!buffer || !buffer.length || !['pdf', 'jpg', 'png'].includes(kind)) return { text: '', pages: 0, languages: null, error: null };
  try {
    // the "not installed" answer needs no turn in the queue
    const st = await status();
    if (!st.available) return { text: '', pages: 0, languages: null, error: NOT_INSTALLED, notInstalled: true };
    if (queueLength() >= maxQueue()) return { text: '', pages: 0, languages: null, error: 'Scanned resume — the text reader is busy; upload the file again in a few minutes', busy: true };
    return await enqueue(() => ocrJob(buffer, kind));
  } catch (err) {
    return { text: '', pages: 0, languages: null, error: `Scanned resume — the text could not be read (${String(err && err.message || err).slice(0, 100)})` };
  }
}

// How many letters (any script) a text has — "nearly empty" is under 80.
const letterCount = (t) => (String(t || '').match(/\p{L}/gu) || []).length;
const MIN_LETTERS = 80;

function forget() { statusCache = null; niceChecked = null; }

module.exports = {
  status, ocrBuffer, letterCount, MIN_LETTERS, NOT_INSTALLED, queueLength, forget, parseLangs,
};
